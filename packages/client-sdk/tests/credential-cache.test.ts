import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { MutationObserver, QueryClient } from "@hyori-cloud/lib/query-core";
import { fakeAPI, user } from "#client-sdk-test/fake-api";

function fixture() {
  const api = fakeAPI();
  const client = createClient({ fetch: api.fetch });

  const cache = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });

  setMutationDefaults(cache);

  return {
    api,
    client,
    cache,
    dispose() {
      client.dispose();
      cache.clear();
    },
  };
}

test("credential transitions remove prior mutation variables and results from the shared cache", async () => {
  const f = fixture();

  try {
    f.api.setAuthUser(user);
    await new MutationObserver(f.cache, f.client.mutation.auth.login.mutationOptions()).mutate({
      email: user.email,
      password: "Synthetic private password",
    });
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
    await new MutationObserver(
      f.cache,
      f.client.mutation.files.createFolder.mutationOptions(),
    ).mutate({ parentId: null, name: "Private account A folder" });
    expect(f.cache.getMutationCache().getAll()).toHaveLength(1);
    await new MutationObserver(f.cache, f.client.mutation.auth.logout.mutationOptions()).mutate({});
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
    f.api.setAuthUser({ ...user, id: "user_b", name: "Account B" });
    await new MutationObserver(f.cache, f.client.mutation.auth.login.mutationOptions()).mutate({
      email: user.email,
      password: "Synthetic second password",
    });
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
  } finally {
    f.dispose();
  }
});

test("removing the executing transition from cache preserves its native lifecycle", async () => {
  const f = fixture();
  const callbacks: string[] = [];
  f.client.mutation.auth.logout.setDefaults(f.cache, {
    onMutate() {
      return { marker: "transition" };
    },
    onSuccess(result, _input, context) {
      expect(result.success).toBe(true);
      expect(context?.marker).toBe("transition");
      callbacks.push("default-success");
    },
    onSettled(_result, _error, _input, context) {
      expect(context?.marker).toBe("transition");
      callbacks.push("default-settled");
    },
  });
  const observer = new MutationObserver(f.cache, f.client.mutation.auth.logout.mutationOptions());
  const unsubscribe = observer.subscribe(() => undefined);

  try {
    const result = await observer.mutate(
      {},
      {
        onSuccess() {
          callbacks.push("observer-success");
        },
      },
    );

    expect(result.success).toBe(true);
    expect(observer.getCurrentResult().status).toBe("success");
    expect(callbacks).toEqual(["default-success", "default-settled", "observer-success"]);
    expect(f.cache.getMutationCache().getAll()).toHaveLength(0);
  } finally {
    unsubscribe();
    observer.reset();
    f.dispose();
  }
});

test("an old mutation settling after logout and another login does not re-enter the shared cache", async () => {
  const api = fakeAPI();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  const client = createClient({
    fetch: async (url, init) => {
      const response = await api.fetch(url, init);

      if (String(init?.body).includes('"operation":"files.createFolder"')) {
        started.resolve();
        await release.promise;
      }

      return response;
    },
  });

  const cache = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });

  setMutationDefaults(cache);

  const oldObserver = new MutationObserver(
    cache,
    client.mutation.files.createFolder.mutationOptions(),
  );

  const old = oldObserver.mutate({ parentId: null, name: "Account A result arriving late" });

  try {
    await started.promise;
    await new MutationObserver(cache, client.mutation.auth.logout.mutationOptions()).mutate({});
    api.setAuthUser({ ...user, id: "user_b", name: "Account B" });
    await new MutationObserver(cache, client.mutation.auth.login.mutationOptions()).mutate({
      email: user.email,
      password: "Synthetic B password",
    });
    release.resolve();
    await old;
    expect(oldObserver.getCurrentResult().status).toBe("success");
    expect(cache.getMutationCache().getAll()).toHaveLength(0);
  } finally {
    release.resolve();
    await old;
    oldObserver.reset();
    client.dispose();
    cache.clear();
  }
});
