import * as bridge from "../../../tooling/artcraft/patches/native-host-v3/host-entry.ts";

/**
 * A synthetic editor inside the real frame bridge: it opens, edits, autosaves and acknowledges
 * through the shipped `native-host-v3` host entry exactly as the Rust engines do, with no engine.
 * Then it behaves as compromised editor code would, and reports what it could reach to `/report`.
 * It proves the frame boundary, never format fidelity.
 */
type Outcome = { reached: true; value: string } | { reached: false; error: string };

/** Every reach the compromised code attempts, by what it tried to get. */
export type Reach =
  | "parentDocument"
  | "parentStorage"
  | "storage"
  | "indexedDb"
  | "cookie"
  | "rpc"
  | "storageDownload"
  | "rpcBlind"
  | "topNavigation"
  | "printHtml"
  | "printSvg"
  | "printPdf";

export type ProbeReport = {
  visit: string;
  /** What the engine handed over by the host computed, or why it couldn't load. */
  engine?: string;
  /** Engine replies the frame got after asking again, or asking for anything else. */
  extraEngines?: number;
  prepared?: string;
  received?: number[];
  autosaved?: boolean;
  attacked?: boolean;
} & Partial<Record<Reach, Outcome>>;

const MINIMAL_PDF = `%PDF-1.1
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj 3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 300 300]>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

const query = new URLSearchParams(window.location.search);
const app = window.location.pathname.split("/")[2] ?? "";
const version = decodeURIComponent(window.location.pathname.split("/")[3] ?? "");
const visit = query.get("visit") ?? "first";
const report: ProbeReport = { visit };

function send() {
  // A no-cors text body: the report itself must not need any of the authority it tests for.
  return fetch("/report", { method: "POST", mode: "no-cors", body: JSON.stringify(report) });
}

async function attempt(run: () => string | Promise<string>): Promise<Outcome> {
  try {
    return { reached: true, value: await run() };
  } catch (error) {
    return { reached: false, error: error instanceof Error ? error.name : String(error) };
  }
}

/** Asks for the engine again, and for API paths by name; the host must answer none of them. */
function askForMore(): Promise<number> {
  return new Promise((resolve) => {
    let replies = 0;

    function count(event: MessageEvent<{ type?: unknown }>) {
      if (event.source === window.parent && String(event.data?.type).endsWith(":engine"))
        replies += 1;
    }

    window.addEventListener("message", count);

    for (const extra of [{}, { url: "/api/rpc" }, { path: "/api/storage/files/secret" }])
      window.parent.postMessage(
        { type: `${app}:engine-request`, protocol: 3, version, ...extra },
        window.location.origin,
      );

    setTimeout(() => {
      window.removeEventListener("message", count);
      resolve(replies);
    }, 1000);
  });
}

async function attack() {
  report.extraEngines = await askForMore();
  report.parentDocument = await attempt(() => window.parent.document.title);
  report.parentStorage = await attempt(
    () => window.parent.localStorage.getItem("hyori-secret") ?? "empty",
  );
  report.storage = await attempt(() => window.localStorage.getItem("hyori-secret") ?? "empty");
  report.indexedDb = await attempt(
    () =>
      new Promise<string>((resolve, reject) => {
        const request = indexedDB.open("hyori-secret");
        request.onsuccess = () => resolve("opened");
        request.onerror = () => reject(request.error);
      }),
  );
  report.cookie = await attempt(() => document.cookie);
  report.rpc = await attempt(async () => {
    const response = await fetch("/api/rpc", {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ operation: "files.list", input: {} }),
    });

    return `${response.status} ${await response.text()}`;
  });
  report.storageDownload = await attempt(async () => {
    const response = await fetch("/api/storage/files/secret", { credentials: "include" });

    return `${response.status} ${await response.text()}`;
  });
  // Unreadable even when sent; the server records whether the person's session came with it.
  report.rpcBlind = await attempt(async () => {
    const response = await fetch("/api/rpc", {
      method: "POST",
      mode: "no-cors",
      credentials: "include",
      body: JSON.stringify({ operation: "files.delete", input: { id: "secret" } }),
    });

    return response.type;
  });
  // Hosted print: only a real PDF opens, and only in this frame's own opaque origin.
  const bytes = (text: string) => new TextEncoder().encode(text);
  const script = `<script>fetch("/api/rpc",{method:"POST",credentials:"include"})</script>`;

  report.printHtml = await attempt(() => {
    bridge.hostShowPdf(bytes(`<!doctype html>${script}`));

    return "accepted";
  });
  report.printSvg = await attempt(() => {
    bridge.hostShowPdf(bytes(`<svg xmlns="http://www.w3.org/2000/svg">${script}</svg>`));

    return "accepted";
  });
  report.printPdf = await attempt(() => {
    bridge.hostShowPdf(bytes(MINIMAL_PDF));

    return "accepted";
  });
  report.topNavigation = await attempt(() => {
    window.top!.location.href = "/top-navigated";

    return "assigned";
  });
}

/** The loader's part: fetch the engine beside this page, as Trunk's loader does, and start it. */
async function loadEngine() {
  try {
    const { instance } = await WebAssembly.instantiateStreaming(
      fetch(new URL("synthetic_bg.wasm", window.location.href)),
    );

    const answer = instance.exports.answer;

    report.engine = answer instanceof Function ? String(answer()) : "no answer";
  } catch (error) {
    report.engine = error instanceof Error ? error.message : String(error);
  }
}

async function run() {
  // A reloaded frame asks again and gets nothing; real loaders would wait, this one reports.
  const engine = loadEngine();

  await (visit === "first"
    ? engine
    : Promise.race([engine, new Promise((resolve) => setTimeout(resolve, 1000))]));

  try {
    if (!bridge.prepareHost(app, version)) throw new Error("not hosted");
  } catch (error) {
    report.prepared = error instanceof Error ? error.message : String(error);
    void send();

    return;
  }

  report.prepared = "ready";
  bridge.attachHostRepaint(() => {});
  bridge.hostReady();

  let revision = 1;
  let content = new Uint8Array();

  setInterval(() => {
    const open = bridge.hostTakeOpen();

    if (open !== null) {
      report.received = [...open.bytes];
      content = new Uint8Array([...open.bytes, 33]);
      bridge.hostOpened(open.openId, "1", String(revision));
      // One edit: the host's autosave asks for it on its own.
      revision += 1;
      bridge.hostObserved("1", String(revision), true);
    }

    const request = bridge.hostTakeSaveRequest();

    if (request !== null) {
      bridge.hostSerialized(
        request.requestId,
        request.documentId,
        String(revision),
        request.name,
        content,
        request.saveAs,
      );
    }

    bridge.hostTakeCancellation();
    bridge.hostTakeFailure();
    bridge.hostTakeDiscard();

    if (bridge.hostTakeAcknowledgement() !== null) {
      bridge.hostAcknowledged("1", String(revision), "1", String(revision), false);
      report.autosaved = true;

      // Saved through the bridge; now behave as compromised code would.
      if (visit === "first" && report.attacked === undefined) {
        report.attacked = true;
        void attack().then(async () => {
          await send();
          // Reloading itself to ask again; the host must not hand the document over twice.
          const next = new URL(window.location.href);
          next.searchParams.set("visit", "reloaded");
          window.location.href = next.href;
        });
      }
    }

    const theme = bridge.hostTakeThemeRequest();

    if (theme !== null) bridge.hostThemeApplied(theme.requestId, theme.theme, "light");
  }, 20);

  // A reloaded frame reports whether anything handed it the document again, then tries to take
  // the frame to another origin, which the host page's own policy must refuse.
  if (visit === "reloaded")
    setTimeout(() => {
      void send().then(() => {
        const elsewhere = new URL(window.location.href);
        elsewhere.hostname = "localhost";
        elsewhere.searchParams.set("visit", "elsewhere");
        window.location.href = elsewhere.href;
      });
    }, 1500);
}

void run();
