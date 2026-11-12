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
  | "topNavigation";

export type ProbeReport = {
  visit: string;
  prepared?: string;
  received?: number[];
  autosaved?: boolean;
  attacked?: boolean;
} & Partial<Record<Reach, Outcome>>;

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

async function attack() {
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
  report.topNavigation = await attempt(() => {
    window.top!.location.href = "/top-navigated";

    return "assigned";
  });
}

function run() {
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

run();
