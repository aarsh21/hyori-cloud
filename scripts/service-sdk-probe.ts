import assert from "node:assert/strict";
import type { ServerConfig } from "@hyori-cloud/api";
import { createClient, type FetchCapability } from "@hyori-cloud/client-sdk";

export async function createServiceProbe(
  config: Pick<ServerConfig, "origin" | "setupToken">,
  send: FetchCapability,
) {
  const cookies = new Map<string, string>();

  const fetchWithCookies: FetchCapability = async (input, init) => {
    const request = new Request(input, init);
    const headers = new Headers(request.headers);
    headers.set("Origin", config.origin);
    headers.set("Cookie", [...cookies].map(([name, value]) => `${name}=${value}`).join("; "));
    const response = await send(new Request(request, { headers }));

    if (!response.ok) console.error("Service probe API failure:", await response.clone().text());

    for (const cookie of response.headers.getSetCookie()) {
      const pair = cookie.split(";", 1)[0];

      if (!pair) continue;
      const separator = pair.indexOf("=");
      cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
    }

    return response;
  };

  const client = createClient({ baseUrl: `${config.origin}/api/rpc`, fetch: fetchWithCookies });

  try {
    await client.rpc.auth.setup({
      setupToken: config.setupToken,
      email: "probe@example.test",
      name: "Persistence probe",
      password: "randomized test account passphrase only",
    });
    const folder = await client.rpc.files.createFolder({ parentId: null, name: "SDK lifecycle" });
    const bytes = new Uint8Array(8 * 1024 * 1024 + 19);
    bytes.fill(77);

    const task = client.uploads.start({
      parentId: folder.id,
      file: new File([bytes], "persistence.txt", { type: "text/plain" }),
    });

    const file = await task.result;
    assert.equal(task.getSnapshot().status, "complete");

    const verify = async () => {
      const status = await client.rpc.auth.status({});
      assert.equal(status.initialized, true);
      assert.equal(status.user?.email, "probe@example.test");
      const listing = await client.rpc.files.list({ parentId: folder.id });
      assert.ok(listing.items.some((item) => item.id === file.id));
      const download = await client.downloads.open({ id: file.id });
      const actual = new Uint8Array(await new Response(download.stream).arrayBuffer());
      assert.deepEqual(actual, bytes);
    };

    await verify();

    return {
      verifyAfterRestart: verify,
      dispose: () => client.dispose(),
    };
  } catch (error) {
    client.dispose();
    throw error;
  }
}
