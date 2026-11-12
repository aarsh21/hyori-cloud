/** Live same-origin script-inclusion probe using disposable, locally generated uploads.
 * HYORI_DELIVERY_ORIGIN=https://… bun apps/web/tooling/check-script-content-types.ts
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createClient } from "@hyori-cloud/client-sdk";
import { z } from "zod";

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;

const account = z
  .object({ email: z.string(), password: z.string() })
  .parse(
    JSON.parse(
      await readFile(
        process.env.HYORI_DELIVERY_STATE ?? join(homedir(), "hyori-delivery/state.json"),
        "utf8",
      ),
    ),
  );

function principal() {
  const cookies = new Map<string, string>();

  const request = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("cookie", [...cookies.values()].join("; "));
    const response = await fetch(new URL(String(input), origin), { ...init, headers });

    for (const value of response.headers.getSetCookie()) {
      const pair = value.split(";")[0]!;
      cookies.set(pair.split("=")[0]!, pair);
    }

    return response;
  };

  const sdk = createClient({ baseUrl: `${origin}/api/rpc`, fetch: request });

  return { sdk, request, cookies };
}

const owner = principal();
const visitor = principal();

const browser = await chromium.launch({
  executablePath:
    process.env.CHROME_PATH ??
    join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome"),
  headless: true,
});

const results = [];
let folderId: string | undefined;

try {
  await owner.sdk.rpc.auth.login(account);

  const folder = await owner.sdk.rpc.files.createFolder({
    parentId: null,
    name: `Script probe ${Date.now()}`,
  });

  folderId = folder.id;

  const upload = async (name: string, type: string, bytes: Uint8Array) => {
    const task = owner.sdk.uploads.start({
      parentId: folder.id,
      file: new File([Uint8Array.from(bytes)], name, { type }),
    });

    try {
      return await task.result;
    } finally {
      task.dispose();
    }
  };

  const javascript = new TextEncoder().encode("globalThis.__hyoriUserScriptExecuted = true;");
  const script = await upload("probe.js", "text/javascript", javascript);
  const disguised = await upload("disguised.png", "image/png", javascript);

  const png = await upload(
    "valid.png",
    "image/png",
    await readFile("apps/server/tests/fixtures/media/red.png"),
  );

  const share = await owner.sdk.rpc.shares.create({
    itemId: folder.id,
    public: true,
    role: "viewer",
  });

  await visitor.sdk.rpc.shares.unlock({
    token: new URL(share.url!).pathname.split("/").at(-1)!,
    password: "",
  });

  for (const [label, actor] of [
    ["owner", owner],
    ["public-link", visitor],
  ] as const) {
    const context = await browser.newContext();

    try {
      await context.addCookies(
        [...actor.cookies.values()].map((pair) => {
          const separator = pair.indexOf("=");

          return { name: pair.slice(0, separator), value: pair.slice(separator + 1), url: origin };
        }),
      );
      const page = await context.newPage();
      await page.goto(origin);
      const download = await actor.sdk.rpc.files.download({ id: script.id });
      const preview = await actor.sdk.rpc.files.preview({ id: png.id });
      const refusedPreview = await actor.sdk.rpc.files.preview({ id: disguised.id });

      for (const [kind, url, expected] of [
        ["javascript original", download.url, 200],
        ["valid image preview", preview.url, 200],
        ["javascript disguised as image", refusedPreview.url, 400],
        ["javascript direct preview", `/api/storage/previews/${script.id}`, 400],
        ["unavailable editor session", "/api/storage/editors/missing?revision=1", 404],
      ] as const) {
        const response = await actor.request(url);
        assert.equal(response.status, expected);
        const contentType = response.headers.get("content-type");
        assert.ok(!/javascript|ecmascript/i.test(contentType ?? ""));
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        await response.arrayBuffer();

        const inclusion = await page.evaluate(async (url) => {
          Reflect.deleteProperty(globalThis, "__hyoriUserScriptExecuted");

          const outcome = await new Promise<string>((resolve) => {
            const script = document.createElement("script");
            script.src = url;
            script.onload = () => resolve("load");
            script.onerror = () => resolve("error");
            document.head.append(script);
          });

          return {
            outcome,
            executed: Object.hasOwn(globalThis, "__hyoriUserScriptExecuted"),
          };
        }, url);

        assert.deepEqual(inclusion, { outcome: "error", executed: false });

        const result = {
          actor: label,
          kind,
          status: response.status,
          contentType,
          nosniff: true,
          ...inclusion,
        };

        results.push(result);
        console.log(JSON.stringify(result));
      }

      // Positive control: same-origin external script inclusion is already permitted by 'self'.
      const allowed = await page.evaluate(async () => {
        const asset = document.querySelector<HTMLLinkElement>('link[rel="modulepreload"]')!.href;

        return new Promise<string>((resolve) => {
          const script = document.createElement("script");
          script.type = "module";
          script.src = asset;
          script.onload = () => resolve("load");
          script.onerror = () => resolve("error");
          document.head.append(script);
        });
      });

      assert.equal(allowed, "load");
      console.log(`PASS ${label}: unnonced trusted same-origin module loads (existing policy)`);
    } finally {
      await context.close();
    }
  }

  const editors = await owner.sdk.rpc.editors.available({});
  console.log(
    JSON.stringify({
      editorApps: editors.apps.length,
      successfulEditorBytesProven: false,
      reason: "No real editor bundle on this stack; only refused editor requests tested",
    }),
  );

  if (process.env.HYORI_SCRIPT_PROBE_OUTPUT)
    await Bun.write(process.env.HYORI_SCRIPT_PROBE_OUTPUT, JSON.stringify(results, null, 2));
} finally {
  if (folderId) await owner.sdk.rpc.files.trash({ id: folderId });
  owner.sdk.dispose();
  visitor.sdk.dispose();
  await browser.close();
}
