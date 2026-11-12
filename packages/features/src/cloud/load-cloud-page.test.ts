import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { QueryClient, dehydrate } from "@hyori-cloud/lib/query";
import { loadCloudPage } from "#features/cloud/react/load-cloud-page.ts";

test("first-document private reads stop at signed-out status; public consent carries no account data", async () => {
  const sdkClient = createClient({
    fetch: async () => Response.json({ ok: true, value: { initialized: true, user: null } }),
  });

  const queryClient = new QueryClient();

  try {
    await loadCloudPage({ sdkClient, queryClient }, "/folders/private-folder");
    expect(dehydrate(queryClient).queries.map((query) => query.state.data)).toEqual([
      { initialized: true, user: null },
    ]);
    queryClient.clear();
    await loadCloudPage({ sdkClient, queryClient }, "/share/public-token");
    expect(dehydrate(queryClient).queries).toEqual([]);
  } finally {
    sdkClient.dispose();
    queryClient.clear();
  }
});
