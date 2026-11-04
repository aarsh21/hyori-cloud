import { afterEach, describe, expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import {
  ClientSDKProvider,
  createQueryUploadQueue,
  setMutationDefaults,
  useClientSDK,
} from "@hyori-cloud/client-sdk/react";
import { QueryClient, QueryClientProvider, useQuery, useQueryClient } from "@hyori-cloud/lib/query";
import { MutationObserver, QueryObserver } from "@hyori-cloud/lib/query-core";
import { createElement } from "@hyori-cloud/lib/react";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { fakeAPI, user } from "#client-sdk-test/fake-api";

// The public provider composition is real; API/storage are explicit fakes.
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const clients: QueryClient[] = [];

afterEach(() => {
  for (const client of clients) client.clear();
  clients.length = 0;
});

function configuredClient() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
  });

  setMutationDefaults(client);
  clients.push(client);

  return client;
}

describe("derived Query acceptance", () => {
  test("two feature observers share SDK/cache; route replacement retains cache; requests isolate", async () => {
    const api = fakeAPI();
    const sdkClient = createClient({ fetch: api.fetch, cacheScope: "account-a" });
    const queryClient = configuredClient();
    const seen: QueryClient[] = [];
    const entries: number[] = [];

    function useFiles() {
      return useQuery(useClientSDK().query.files.list.getOptions({ parentId: null }));
    }

    function FilesFeature() {
      seen.push(useQueryClient());
      const listing = useFiles();
      entries.push(listing.data?.items.length ?? -1);

      return null;
    }

    function SidebarFeature() {
      seen.push(useQueryClient());
      useFiles();

      return null;
    }

    function Providers({ route }: { route: "files" | "other" }) {
      return (
        <QueryClientProvider client={queryClient}>
          <ClientSDKProvider sdkClient={sdkClient}>
            <SidebarFeature />
            {route === "files" ? <FilesFeature /> : null}
          </ClientSDKProvider>
        </QueryClientProvider>
      );
    }

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(<Providers route="files" />);
    });
    await act(async () => {
      await queryClient.ensureQueryData(sdkClient.query.files.list.getOptions({ parentId: null }));
    });
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.every((client) => client === queryClient)).toBe(true);
    expect(api.calls.filter((call) => call === "files.list")).toHaveLength(1);
    await act(async () => {
      renderer!.update(<Providers route="other" />);
    });
    await act(async () => {
      renderer!.update(<Providers route="files" />);
    });
    expect(api.calls.filter((call) => call === "files.list")).toHaveLength(1);
    const before = api.calls.length;

    const mutation = new MutationObserver(
      queryClient,
      sdkClient.mutation.files.createFolder.mutationOptions(),
    );

    await act(async () => {
      await mutation.mutate({ parentId: null, name: "Pictures" });
    });
    expect(api.calls.slice(before)).toContain("files.list");
    expect(
      queryClient.getQueryData(sdkClient.query.files.list.getKey({ parentId: null }))?.items,
    ).toHaveLength(1);
    await act(async () => {
      renderer!.unmount();
    });
    const request2 = configuredClient();
    expect(request2).not.toBe(queryClient);
    expect(
      request2.getQueryData(sdkClient.query.files.list.getKey({ parentId: null })),
    ).toBeUndefined();
    expect(entries).toContain(0);
    sdkClient.dispose();
  });

  test("central invalidation preserves unrelated entries and exact input/scope keys", async () => {
    const api = fakeAPI();
    const a = createClient({ fetch: api.fetch, cacheScope: "a" });
    const b = createClient({ fetch: api.fetch, cacheScope: "b" });
    const client = configuredClient();
    const isolated = configuredClient();
    const first = a.query.files.list.getOptions({ parentId: "folder_1" });
    const second = a.query.files.list.getOptions({ parentId: "folder_2" });
    const otherScope = b.query.files.list.getOptions({ parentId: "folder_1" });
    await Promise.all([
      client.fetchQuery(first),
      client.fetchQuery(second),
      client.fetchQuery(otherScope),
      isolated.fetchQuery(first),
    ]);
    await client.fetchQuery(a.query.auth.status.getOptions({}));
    await client.invalidateQueries({ queryKey: first.queryKey, exact: true, refetchType: "none" });
    expect(client.getQueryState(first.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(second.queryKey)?.isInvalidated).toBe(false);
    expect(client.getQueryState(otherScope.queryKey)?.isInvalidated).toBe(false);
    const options = a.mutation.files.createFolder.mutationOptions();
    expect(options.onSuccess).toBeUndefined();
    expect(client.getMutationDefaults(options.mutationKey!).onSuccess).toBeFunction();
    setMutationDefaults(client);
    await new MutationObserver(client, options).mutate({ parentId: null, name: "One" });
    expect(client.getQueryState(otherScope.queryKey)?.isInvalidated).toBe(true);
    expect(client.getQueryState(a.query.auth.status.getKey({}))?.isInvalidated).toBe(false);
    expect(isolated.getQueryState(first.queryKey)?.isInvalidated).toBe(false);
    a.dispose();
    b.dispose();
  });

  test("typed custom defaults retain callbacks and mandatory policy in either registration order", async () => {
    for (const registerFirst of [false, true]) {
      const api = fakeAPI();
      const sdk = createClient({ fetch: api.fetch });
      const client = new QueryClient();
      clients.push(client);
      const seen: string[] = [];

      const defaults = () =>
        sdk.mutation.files.createFolder.setDefaults(client, {
          onMutate(input) {
            return { original: input.name };
          },
          onSuccess(folder, input, context) {
            seen.push(`${folder.name}:${input.name}:${context?.original}`);
            expect(client.getQueryState(sdk.query.files.list.getKey({}))?.isInvalidated).toBe(true);
          },
        });

      if (registerFirst) defaults();
      setMutationDefaults(client);

      if (!registerFirst) defaults();
      setMutationDefaults(client);
      await client.fetchQuery(sdk.query.files.list.getOptions({}));
      await new MutationObserver(client, sdk.mutation.files.createFolder.mutationOptions()).mutate({
        parentId: null,
        name: "Pictures",
      });
      expect(seen).toEqual(["Pictures:Pictures:Pictures"]);
      sdk.dispose();
    }
  });

  test("a failing custom callback cannot bypass mandatory invalidation", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    await client.fetchQuery(sdk.query.files.list.getOptions({}));
    sdk.mutation.files.createFolder.setDefaults(client, {
      onSuccess() {
        throw new Error("Custom callback failed");
      },
    });
    await expect(
      new MutationObserver(client, sdk.mutation.files.createFolder.mutationOptions()).mutate({
        parentId: null,
        name: "Pictures",
      }),
    ).rejects.toThrow("Custom callback failed");
    expect(client.getQueryState(sdk.query.files.list.getKey({}))?.isInvalidated).toBe(true);
    sdk.dispose();
  });

  test("ordinary observers distinguish initial absence, success-empty, and retained-data refresh errors", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    const observer = new QueryObserver(client, sdk.query.files.list.getOptions({}));
    expect(observer.getCurrentResult().data).toBeUndefined();
    expect(observer.getCurrentResult().status).toBe("pending");
    const unsubscribe = observer.subscribe(() => undefined);
    await observer.refetch();
    expect(observer.getCurrentResult().data?.items).toEqual([]);
    expect(observer.getCurrentResult().status).toBe("success");
    api.failListing(true);
    await observer.refetch();
    expect(observer.getCurrentResult().status).toBe("error");
    expect(observer.getCurrentResult().data?.items).toEqual([]);
    expect(observer.getCurrentResult().error).toHaveProperty("code", "service.unavailable");
    unsubscribe();
    observer.destroy();
    sdk.dispose();
  });

  test("independent feature subscription owners do not rerender for another resource", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    await client.fetchQuery(sdk.query.files.list.getOptions({}));
    await client.fetchQuery(sdk.query.auth.status.getOptions({}));
    let fileRenders = 0;
    let authRenders = 0;

    function FilesOwner() {
      const result = useQuery(useClientSDK().query.files.list.getOptions({}));
      void result.data;
      fileRenders++;

      return null;
    }

    function AuthOwner() {
      const result = useQuery(useClientSDK().query.auth.status.getOptions({}));
      void result.data;
      authRenders++;

      return null;
    }

    let renderer: ReactTestRenderer;
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={client}>
          <ClientSDKProvider sdkClient={sdk}>
            <FilesOwner />
            <AuthOwner />
          </ClientSDKProvider>
        </QueryClientProvider>,
      );
    });
    const originalAuth = authRenders;
    const originalFiles = fileRenders;
    await act(async () => {
      client.setQueryData(sdk.query.files.list.getKey({}), (previous) =>
        previous ? { ...previous, nextCursor: "page_2" } : previous,
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(fileRenders).toBeGreaterThan(originalFiles);
    expect(authRenders).toBe(originalAuth);
    const afterFiles = fileRenders;
    await act(async () => {
      client.setQueryData(sdk.query.auth.status.getKey({}), { initialized: false, user: null });
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(authRenders).toBeGreaterThan(originalAuth);
    expect(fileRenders).toBe(afterFiles);
    await act(async () => {
      renderer!.unmount();
    });
    sdk.dispose();
  });

  test("subscription upload retries reconcile the declaration policy without UI invalidation", async () => {
    const api = fakeAPI();
    api.failParts(10);
    const sdk = createClient({ fetch: api.fetch });
    const start = sdk.uploads.start;
    sdk.uploads.start = (input) => start(input, { maxRetries: 0, retryDelayMs: 0 });
    const client = configuredClient();
    await client.fetchQuery(sdk.query.files.list.getOptions({}));
    const queue = createQueryUploadQueue(sdk, client, { read: () => [], write: () => undefined });
    queue.add([new File(["1234567"], "hello.txt", { type: "text/plain", lastModified: 42 })], null);
    const row = queue.getEntries()[0];

    if (row?.state !== "started") throw new Error("Upload did not start");
    await row.task.result.catch(() => undefined);
    expect(row.task.getSnapshot().status).toBe("failed");
    expect(client.getQueryState(sdk.query.files.list.getKey({}))?.isInvalidated).toBe(false);
    api.failParts(0);
    queue.retry(row.id);
    await row.task.result;
    expect(client.getQueryState(sdk.query.files.list.getKey({}))?.isInvalidated).toBe(true);
    expect(api.beginCount).toBe(1);
    queue.dispose();
    sdk.dispose();
  });

  test("credential mutations replace previous identity even when refresh fails", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    const options = sdk.query.auth.status.getOptions({});
    api.setAuthUser(user);
    await client.fetchQuery(options);
    const observer = new QueryObserver(client, options);
    const unsubscribe = observer.subscribe(() => undefined);
    const replacement = { ...user, id: "user_2", name: "Replacement" };
    api.setAuthUser(replacement);
    api.failAuthStatus(true);
    const credentials = { email: replacement.email, password: "test-password" };

    await new MutationObserver(client, sdk.mutation.auth.login.mutationOptions()).mutate(
      credentials,
    );
    expect(observer.getCurrentResult().status).toBe("error");
    expect(observer.getCurrentResult().data?.user).toEqual(replacement);
    await new MutationObserver(client, sdk.mutation.auth.setup.mutationOptions()).mutate({
      ...credentials,
      name: replacement.name,
      setupToken: "test-setup-token",
    });
    expect(observer.getCurrentResult().data?.user).toEqual(replacement);
    await new MutationObserver(client, sdk.mutation.auth.acceptInvite.mutationOptions()).mutate({
      ...credentials,
      name: replacement.name,
      token: "test-invite-token",
    });
    expect(observer.getCurrentResult().data?.user).toEqual(replacement);
    await new MutationObserver(client, sdk.mutation.auth.logout.mutationOptions()).mutate({});
    expect(observer.getCurrentResult().data).toEqual({ initialized: true, user: null });
    expect(observer.getCurrentResult().status).toBe("error");
    unsubscribe();
    observer.destroy();
    sdk.dispose();
  });

  test("logout does not invent initialization for a known uninitialized instance", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    const key = sdk.query.auth.status.getKey({});
    client.setQueryData(key, { initialized: false, user: null });
    await new MutationObserver(client, sdk.mutation.auth.logout.mutationOptions()).mutate({});
    expect(client.getQueryData(key)?.initialized).toBe(false);
    expect(client.getQueryData(key)?.user).toBeNull();
    sdk.dispose();
  });

  test("auth transitions purge privileged caches while preserving and refreshing identity", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });
    const client = configuredClient();
    await client.fetchQuery(sdk.query.files.list.getOptions({}));
    await client.fetchQuery(sdk.query.auth.status.getOptions({}));
    await new MutationObserver(client, sdk.mutation.auth.logout.mutationOptions()).mutate({});
    expect(client.getQueryData(sdk.query.files.list.getKey({}))).toBeUndefined();
    expect(client.getQueryState(sdk.query.auth.status.getKey({}))?.isInvalidated).toBe(true);
    sdk.dispose();
  });
});

void createElement;
