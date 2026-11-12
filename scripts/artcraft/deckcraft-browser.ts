import { watch } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { z } from "zod";
import { inspectSyntheticOutput, syntheticDeckCraft } from "./deckcraft-synthetic.ts";
import { sha256 } from "./evidence-bytes.ts";

type CdpCommand =
  | { method: "Target.createTarget"; params: { url: string } }
  | { method: "Page.enable" | "Runtime.enable" | "Log.enable" | "Browser.getVersion" }
  | { method: "Page.navigate"; params: { url: string } }
  | { method: "Page.setLifecycleEventsEnabled"; params: { enabled: true } }
  | { method: "Target.attachToTarget"; params: { targetId: string; flatten: true } }
  | {
      method: "Runtime.evaluate";
      params: { expression: string; returnByValue: true; awaitPromise: true };
    }
  | {
      method: "Input.dispatchKeyEvent";
      params: {
        type: "keyDown" | "keyUp";
        key: string;
        code: string;
        windowsVirtualKeyCode: number;
        modifiers: number;
      };
    }
  | { method: "Browser.setDownloadBehavior"; params: { behavior: "deny"; eventsEnabled: true } };

const cdpResponse = z.object({
  id: z.number().optional(),
  result: z.unknown().optional(),
  error: z.object({ message: z.string() }).optional(),
  method: z.string().optional(),
  params: z.json().optional(),
});

const observations = z.array(
  z
    .object({
      type: z.string(),
      dirty: z.boolean().optional(),
      error: z.string().optional(),
      saveId: z.string().optional(),
      bytes: z.number().optional(),
    })
    .passthrough(),
);

const [, , distArgument, browserArgument, outputArgument] = process.argv;

if (!distArgument || !browserArgument || !outputArgument || process.argv.length !== 5)
  throw new Error(
    "Usage: bun scripts/artcraft/deckcraft-browser.ts MODIFIED_DIST INSTALLED_CHROMIUM NEW_EVIDENCE_DIRECTORY",
  );

const dist = resolve(distArgument);
const output = resolve(outputArgument);

await mkdir(output);

const profile = await mkdtemp(join(tmpdir(), "hyori-deck-browser-"));
const fixture = syntheticDeckCraft();

const built = await Bun.build({
  entrypoints: ["tooling/artcraft/patches/deckcraft-host-v1/browser-parent.ts"],
  target: "browser",
  format: "esm",
});

if (!built.success || built.outputs.length !== 1) throw new Error("Browser fixture bundle failed");

const parentJs = await built.outputs[0]!.text();

await writeFile(join(output, "synthetic.deckcraft"), fixture, { flag: "wx" });

await writeFile(join(output, "parent.js"), parentJs, { flag: "wx" });

const html =
  '<!doctype html><meta charset="utf-8"><title>Synthetic DeckCraft transport test</title><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}</style><iframe sandbox="allow-scripts allow-same-origin" title="Synthetic editor fixture"></iframe><script type="module" src="/parent.js"></script>';

await writeFile(join(output, "parent.html"), html, { flag: "wx" });

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(request) {
    const path = decodeURIComponent(new URL(request.url).pathname);

    if (path === "/") return new Response(html, { headers: { "content-type": "text/html" } });

    if (path === "/parent.js")
      return new Response(parentJs, { headers: { "content-type": "text/javascript" } });

    if (path === "/synthetic.deckcraft") return new Response(new Uint8Array(fixture));

    if (!path.startsWith("/editor/")) return new Response("Not found", { status: 404 });
    const file = resolve(dist, path.slice("/editor/".length));

    if (!file.startsWith(`${dist}${sep}`)) return new Response("Invalid path", { status: 400 });
    const bytes = Bun.file(file);

    if (!(await bytes.exists())) return new Response("Not found", { status: 404 });

    return new Response(bytes, {
      headers: { "content-type": file.endsWith(".wasm") ? "application/wasm" : bytes.type },
    });
  },
});

let watcher: ReturnType<typeof watch> | undefined;
let portTimer: ReturnType<typeof setTimeout> | undefined;

const portReady = new Promise<string>((resolvePort, reject) => {
  watcher = watch(profile, () => {
    void readFile(join(profile, "DevToolsActivePort"), "utf8")
      .then((text) => {
        const [port, endpoint] = text.trim().split("\n");

        if (port && endpoint?.startsWith("/devtools/browser/"))
          resolvePort(`ws://127.0.0.1:${port}${endpoint}`);
      })
      .catch(() => {});
  });
  portTimer = setTimeout(
    () => reject(new Error("Installed Chromium did not expose its local debugging endpoint")),
    30_000,
  );
});

const args = [
  browserArgument,
  "--headless=new",
  "--remote-debugging-port=0",
  "--remote-debugging-address=127.0.0.1",
  `--user-data-dir=${profile}`,
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--disable-extensions",
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--window-size=1280,900",
  "--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1",
  "about:blank",
];

await writeFile(
  join(output, "browser-command.json"),
  JSON.stringify(
    { args, osSandboxDisabled: false, localhostOnlyServer: true, syntheticBackendOnly: true },
    null,
    2,
  ),
);

const child = Bun.spawn(args, {
  stdin: "ignore",
  stdout: Bun.file(join(output, "browser.stdout")),
  stderr: Bun.file(join(output, "browser.stderr")),
});

let socket: WebSocket | undefined;
let downloadAttempts = 0;
const browserEvents: z.infer<typeof cdpResponse>[] = [];

try {
  const endpoint = await portReady;
  watcher?.close();
  clearTimeout(portTimer);
  socket = new WebSocket(endpoint);
  await new Promise<void>((resolveSocket, reject) => {
    socket!.addEventListener("open", () => resolveSocket(), { once: true });
    socket!.addEventListener("error", () => reject(new Error("CDP socket failed")), { once: true });
  });
  let sequence = 0;
  const pending = new Map<number, { accept(response: z.infer<typeof cdpResponse>): void }>();
  const loaded = new Set<string>();
  const loadWaiters = new Map<string, () => void>();
  socket.addEventListener("message", (event) => {
    const response = cdpResponse.parse(JSON.parse(z.string().parse(event.data)));

    if (response.method === "Browser.downloadWillBegin") downloadAttempts += 1;

    if (
      response.method &&
      [
        "Runtime.consoleAPICalled",
        "Runtime.exceptionThrown",
        "Log.entryAdded",
        "Browser.downloadWillBegin",
      ].includes(response.method) &&
      browserEvents.length < 1000
    )
      browserEvents.push(response);

    if (response.method === "Page.lifecycleEvent") {
      const lifecycle = z.object({ loaderId: z.string(), name: z.string() }).parse(response.params);

      if (lifecycle.name === "load") {
        loaded.add(lifecycle.loaderId);
        loadWaiters.get(lifecycle.loaderId)?.();
        loadWaiters.delete(lifecycle.loaderId);
      }
    }

    if (response.id !== undefined) {
      pending.get(response.id)?.accept(response);
      pending.delete(response.id);
    }
  });

  async function send<T>(
    command: CdpCommand,
    schema: z.ZodType<T>,
    sessionId?: string,
  ): Promise<T> {
    sequence += 1;
    const id = sequence;

    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP timed out: ${command.method}`));
      }, 130_000);

      pending.set(id, {
        accept(response) {
          clearTimeout(timer);

          try {
            if (response.error) throw new Error(response.error.message);
            resolveResult(schema.parse(response.result));
          } catch (error) {
            reject(error);
          }
        },
      });
      const packet: CdpCommand & { id: number; sessionId?: string } = { id, ...command };

      if (sessionId) packet.sessionId = sessionId;
      socket!.send(JSON.stringify(packet));
    });
  }

  await send(
    { method: "Browser.setDownloadBehavior", params: { behavior: "deny", eventsEnabled: true } },
    z.object({}),
  );

  const target = await send(
    { method: "Target.createTarget", params: { url: "about:blank" } },
    z.object({ targetId: z.string() }),
  );

  const attached = await send(
    { method: "Target.attachToTarget", params: { targetId: target.targetId, flatten: true } },
    z.object({ sessionId: z.string() }),
  );

  for (const method of ["Page.enable", "Runtime.enable", "Log.enable"] as const)
    await send({ method }, z.object({}), attached.sessionId);

  const browserVersion = await send(
    { method: "Browser.getVersion" },
    z.object({
      product: z.string(),
      revision: z.string(),
      userAgent: z.string(),
      jsVersion: z.string(),
    }),
  );

  await writeFile(join(output, "browser-version.json"), JSON.stringify(browserVersion, null, 2));
  await send(
    { method: "Page.setLifecycleEventsEnabled", params: { enabled: true } },
    z.object({}),
    attached.sessionId,
  );

  const navigation = await send(
    { method: "Page.navigate", params: { url: `http://127.0.0.1:${server.port}/` } },
    z.object({ loaderId: z.string() }),
    attached.sessionId,
  );

  if (!loaded.has(navigation.loaderId))
    await new Promise<void>((resolveLoaded, reject) => {
      const timer = setTimeout(() => {
        loadWaiters.delete(navigation.loaderId);
        reject(new Error("Fixture page did not load"));
      }, 30_000);

      loadWaiters.set(navigation.loaderId, () => {
        clearTimeout(timer);
        resolveLoaded();
      });
    });

  async function evaluate<T>(expression: string, schema: z.ZodType<T>): Promise<T> {
    const result = await send(
      {
        method: "Runtime.evaluate",
        params: { expression, returnByValue: true, awaitPromise: true },
      },
      z
        .object({ result: z.object({ value: schema }), exceptionDetails: z.unknown().optional() })
        .refine((value) => value.exceptionDetails === undefined, "Browser expression threw"),
      attached.sessionId,
    );

    return result.result.value;
  }

  async function key(key: string, code: string, windowsVirtualKeyCode: number, modifiers = 0) {
    for (const type of ["keyDown", "keyUp"] as const)
      await send(
        {
          method: "Input.dispatchKeyEvent",
          params: { type, key, code, windowsVirtualKeyCode, modifiers },
        },
        z.object({}),
        attached.sessionId,
      );
  }

  await evaluate(
    'new Promise(resolve => { if (window.deckFixture) resolve(true); else window.addEventListener("load", () => resolve(Boolean(window.deckFixture)), {once:true}); })',
    z.literal(true),
  );
  await evaluate('window.deckFixture.waitFor("deckcraft:opened")', z.literal(true));
  await evaluate("window.deckFixture.focus(); true", z.literal(true));
  await key("Enter", "Enter", 13);
  await evaluate('window.deckFixture.waitFor("deckcraft:dirty", 2)', z.literal(true));
  await key("s", "KeyS", 83, 2);
  await evaluate('window.deckFixture.waitFor("deckcraft:save")', z.literal(true));

  const firstOutput = Buffer.from(
    await evaluate(
      "window.deckFixture.output()",
      z.array(z.number().int().min(0).max(255)).max(1024 * 1024),
    ),
  );

  await writeFile(join(output, "saved-snapshot.deckcraft"), firstOutput);
  const inspected = inspectSyntheticOutput(firstOutput);
  // An additional actual editor edit while the earlier serialized snapshot awaits persistence.
  await key("Enter", "Enter", 13);
  await evaluate('window.deckFixture.waitFor("deckcraft:dirty", 3)', z.literal(true));
  // Backend failure/conflict retention is separately covered by the executable protocol tests.
  await evaluate('window.deckFixture.acknowledge("saved"); true', z.literal(true));
  await evaluate('window.deckFixture.waitFor("deckcraft:saved")', z.literal(true));
  await key("s", "KeyS", 83, 2);
  await evaluate('window.deckFixture.waitFor("deckcraft:save", 2)', z.literal(true));
  await evaluate('window.deckFixture.acknowledge("saved"); true', z.literal(true));
  await evaluate('window.deckFixture.waitFor("deckcraft:saved", 2)', z.literal(true));
  await evaluate("window.deckFixture.reopen(); true", z.literal(true));
  await evaluate('window.deckFixture.waitFor("deckcraft:opened", 2)', z.literal(true));
  await evaluate("window.deckFixture.focus(); true", z.literal(true));
  await key("s", "KeyS", 83, 2);
  await evaluate('window.deckFixture.waitFor("deckcraft:save", 3)', z.literal(true));

  const reopenedOutput = Buffer.from(
    await evaluate(
      "window.deckFixture.output()",
      z.array(z.number().int().min(0).max(255)).max(1024 * 1024),
    ),
  );

  const reopened = inspectSyntheticOutput(reopenedOutput);

  if (reopened.presentation.slides?.length !== 3)
    throw new Error("Fresh real-WASM frame did not reopen the three-slide saved document");
  await writeFile(join(output, "reopened-snapshot.deckcraft"), reopenedOutput);
  await evaluate('window.deckFixture.acknowledge("saved"); true', z.literal(true));
  await evaluate('window.deckFixture.waitFor("deckcraft:saved", 3)', z.literal(true));
  const events = await evaluate("window.deckFixture.observations()", observations);
  await writeFile(join(output, "events.json"), JSON.stringify(events, null, 2));

  if (!events.some((event) => event.type === "deckcraft:saved" && event.dirty === true))
    throw new Error("Acknowledging old snapshot incorrectly cleared newer edits");

  if ((inspected.presentation.slides?.length ?? 0) < 2)
    throw new Error("Actual editor change missing from saved snapshot");

  if (downloadAttempts) throw new Error("Host mode attempted a browser download");
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "passed",
        syntheticNativeInputSha256: sha256(fixture),
        savedNativeOutputSha256: sha256(firstOutput),
        savedSlides: inspected.presentation.slides?.length,
        retainedNewerDirtyState: true,
        downloadAttempts,
        realWasmExecuted: true,
        nativeReopenedInWasm: true,
        reopenedSlides: reopened.presentation.slides?.length,
        reopenedNativeOutputSha256: sha256(reopenedOutput),
        cloudPersistenceVerified: false,
        pptxFidelityVerified: false,
      },
      null,
      2,
    ),
  );
  console.log(`Synthetic real-WASM native browser fixture passed: ${output}`);
} catch (error) {
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(
      {
        status: "failed",
        error: String(error),
        cloudPersistenceVerified: false,
        pptxFidelityVerified: false,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  await writeFile(join(output, "browser-events.json"), JSON.stringify(browserEvents, null, 2));
  watcher?.close();
  clearTimeout(portTimer);
  socket?.close();
  child.kill();
  await child.exited;
  await server.stop(true);
  await rm(profile, { recursive: true, force: true });
}
