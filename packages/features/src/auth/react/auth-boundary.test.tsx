import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type { User } from "@hyori-cloud/client-sdk";
import { ClientSDKProvider, setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { Schema } from "@hyori-cloud/lib/effect";
import { QueryClient, QueryClientProvider } from "@hyori-cloud/lib/query";
import { MutationObserver } from "@hyori-cloud/lib/query-core";
import { act, create } from "react-test-renderer";
import type { ReactTestRenderer } from "react-test-renderer";
import { AuthBoundary } from "#features/auth/react/auth-boundary.tsx";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("real AuthBoundary removes old authenticated content after logout despite a failed identity refresh", async () => {
  const user: User = {
    id: "user_1",
    email: "person@example.test",
    name: "Person",
    role: "admin",
    quotaBytes: 1000,
    usedBytes: 7,
  };

  let failRefresh = false;
  const decodeRequest = Schema.decodeUnknownSync(Schema.Struct({ operation: Schema.String }));

  const sdk = createClient({
    fetch: async (_url, init) => {
      const { operation } = decodeRequest(await new Response(init?.body).json());

      if (operation === "auth.logout") return Response.json({ ok: true, value: { success: true } });

      if (operation !== "auth.status") throw new Error(`Unexpected operation: ${operation}`);

      if (failRefresh)
        return Response.json(
          { ok: false, error: { code: "service.unavailable", message: "Refresh unavailable" } },
          { status: 503 },
        );

      return Response.json({ ok: true, value: { initialized: true, user } });
    },
  });

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });

  setMutationDefaults(queryClient);
  await queryClient.fetchQuery(sdk.query.auth.status.getOptions({}));
  queryClient.setQueryData(sdk.query.files.list.getKey({}), {
    items: [],
    folder: null,
    breadcrumbs: [],
    nextCursor: null,
  });

  function PrivateContent() {
    return "Private content";
  }

  let renderer: ReactTestRenderer | undefined;

  try {
    await act(async () => {
      renderer = create(
        <QueryClientProvider client={queryClient}>
          <ClientSDKProvider sdkClient={sdk}>
            <AuthBoundary>
              <PrivateContent />
            </AuthBoundary>
          </ClientSDKProvider>
        </QueryClientProvider>,
      );
    });
    expect(renderer!.root.findAllByType(PrivateContent)).toHaveLength(1);
    failRefresh = true;
    await act(async () => {
      await new MutationObserver(queryClient, sdk.mutation.auth.logout.mutationOptions()).mutate(
        {},
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(queryClient.getQueryState(sdk.query.auth.status.getKey({}))?.status).toBe("error");
    const cachedStatus = queryClient.getQueryData(sdk.query.auth.status.getKey({}));
    expect(cachedStatus?.initialized).toBe(true);
    expect(cachedStatus?.user).toBeNull();
    expect(queryClient.getQueryData(sdk.query.files.list.getKey({}))).toBeUndefined();
    expect(renderer!.root.findAllByType(PrivateContent)).toHaveLength(0);
    expect(renderer!.root.findAllByProps({ id: "login-email" }).length).toBeGreaterThan(0);
  } finally {
    await act(async () => renderer?.unmount());
    queryClient.clear();
    sdk.dispose();
  }
});
