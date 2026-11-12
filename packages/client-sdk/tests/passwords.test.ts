import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { Match, Schema } from "@hyori-cloud/lib/effect";
import { MutationObserver, QueryClient } from "@hyori-cloud/lib/query-core";
import { user } from "#client-sdk-test/fake-api";

const request = Schema.decodeUnknownSync(
  Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
);

test("generated password operations are consumable through RPC and Query without client orchestration", async () => {
  const inputs: unknown[] = [];
  const token = "b".repeat(64);

  const client = createClient({
    fetch: async (_url, init) => {
      const call = request(await new Response(init?.body).json());
      inputs.push(call);

      const value = Match.value(call.operation).pipe(
        Match.when("admin.createPasswordReset", () => ({
          token,
          expiresAt: "2026-11-13T12:00:00Z",
        })),
        Match.when("auth.resetPassword", () => ({ success: true, userId: user.id })),
        Match.orElse(() => ({ success: true })),
      );

      return Response.json({ ok: true, value });
    },
  });

  const cache = new QueryClient();
  setMutationDefaults(cache);

  try {
    const link = await new MutationObserver(
      cache,
      client.mutation.admin.createPasswordReset.mutationOptions(),
    ).mutate({ userId: user.id });

    expect(link).toEqual({ token, expiresAt: "2026-11-13T12:00:00Z" });
    expect(
      await new MutationObserver(
        cache,
        client.mutation.auth.changePassword.mutationOptions(),
      ).mutate({ currentPassword: "old password phrase", newPassword: "new password phrase" }),
    ).toEqual({ success: true });
    expect(
      await client.rpc.auth.resetPassword({ token, newPassword: "replacement phrase" }),
    ).toEqual({ success: true, userId: user.id });
    expect(inputs).toEqual([
      { operation: "admin.createPasswordReset", input: { userId: user.id } },
      {
        operation: "auth.changePassword",
        input: { currentPassword: "old password phrase", newPassword: "new password phrase" },
      },
      { operation: "auth.resetPassword", input: { token, newPassword: "replacement phrase" } },
    ]);
  } finally {
    client.dispose();
    cache.clear();
  }
});

test("reset immediately clears only the affected cached identity even when refreshing status fails", async () => {
  for (const target of [user.id, "another_account"]) {
    let failStatus = false;

    const client = createClient({
      fetch: async (_url, init) => {
        const call = request(await new Response(init?.body).json());

        if (call.operation === "auth.status") {
          return failStatus
            ? Response.json(
                { ok: false, error: { code: "service.unavailable", message: "offline" } },
                { status: 503 },
              )
            : Response.json({ ok: true, value: { initialized: true, user } });
        }

        failStatus = true;

        return Response.json({ ok: true, value: { success: true, userId: target } });
      },
    });

    const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    setMutationDefaults(cache);

    try {
      await cache.fetchQuery(client.query.auth.status.getOptions({}));
      await new MutationObserver(
        cache,
        client.mutation.auth.resetPassword.mutationOptions(),
      ).mutate({ token: "c".repeat(64), newPassword: "new account phrase" });
      await expect(cache.fetchQuery(client.query.auth.status.getOptions({}))).rejects.toBeDefined();
      expect(cache.getQueryData(client.query.auth.status.getKey({}))).toEqual({
        initialized: true,
        user: target === user.id ? null : user,
      });
      expect(cache.getMutationCache().getAll()).toHaveLength(0);
    } finally {
      client.dispose();
      cache.clear();
    }
  }
});
