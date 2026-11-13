import {
  decodeNativeHostCommand,
  NATIVE_HOST_PROTOCOL,
} from "@hyori-cloud/client-sdk/editor-runtime";
import type {
  NativeErrorCode,
  NativeHostCommand,
  NativeTheme,
} from "@hyori-cloud/client-sdk/editor-runtime";
import { createNativeHostProtocol, type NativeHostPorts } from "./host-protocol.ts";

const configurations = new Map<string, Pick<NativeHostPorts, "app" | "replacementExtensions">>([
  [
    "wordcraft",
    {
      app: "wordcraft",
      replacementExtensions: [".docx", ".docm", ".dotx", ".dotm", ".odt", ".rtf"],
    },
  ],
  ["gridcraft", { app: "gridcraft", replacementExtensions: [".xlsx"] }],
  ["pdfcraft", { app: "pdfcraft", replacementExtensions: [".pdf"] }],
  ["deckcraft", { app: "deckcraft", replacementExtensions: [".deckcraft"] }],
]);

let protocol: ReturnType<typeof createNativeHostProtocol> | null = null;
let repaint: (() => void) | null = null;

function bridge() {
  if (!protocol) throw new Error("Native host was not prepared");

  return protocol;
}

export function hostRequested() {
  return new URLSearchParams(window.location.search).get("host") === "parent";
}

function isEngine(
  command: NativeHostCommand | null,
): command is Extract<NativeHostCommand, { type: `${string}:engine` }> {
  return command?.type.endsWith(":engine") === true;
}

/**
 * Engine handoff. An opaque-origin frame can't use the HTTP cache, so it would download its engine
 * on every open. The wasm-bindgen glue imports this module before Trunk's loader fetches the
 * engine, so the one `_bg.wasm` request beside this page asks the host instead. The request names
 * nothing; the host answers with the verified engine of the descriptor it holds, or null to load
 * it the ordinary way. Every other request is left alone.
 */
function takeEngineFromHost() {
  if (!hostRequested() || window.origin !== "null" || window.parent === window) return;
  const [, root, app = "", version = ""] = window.location.pathname.split("/");

  if (root !== "artcraft" || !configurations.has(app) || version === "") return;
  const directory = new URL(".", window.location.href).href;
  const load = window.fetch.bind(window);
  let asked = false;

  window.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);

    if (asked || url.search !== "" || !url.pathname.endsWith("_bg.wasm")) return load(input, init);

    if (new URL(".", url).href !== directory) return load(input, init);
    asked = true;

    return new Promise<Response>((resolve) => {
      function receive(event: MessageEvent) {
        if (event.source !== window.parent || event.origin !== window.location.origin) return;
        const command = decodeNativeHostCommand(event.data);

        if (!isEngine(command) || !command.type.startsWith(`${app}:`)) return;

        if (command.version !== version) return;
        window.removeEventListener("message", receive);
        resolve(
          command.bytes === null
            ? load(input, init)
            : new Response(
                new ReadableStream({
                  start(controller) {
                    // The transferred, verified buffer belongs to this frame. Response(buffer)
                    // would copy the whole engine before the streaming compiler could read it.
                    controller.enqueue(new Uint8Array(command.bytes!));
                    controller.close();
                  },
                }),
                { headers: { "content-type": "application/wasm" } },
              ),
        );
      }

      window.addEventListener("message", receive);
      window.parent.postMessage(
        { type: `${app}:engine-request`, protocol: NATIVE_HOST_PROTOCOL, version },
        window.location.origin,
      );
    });
  };
}

takeEngineFromHost();

/** Prepare before WebRunner startup, so native initialization failure has a real error surface.
 * Nothing accepts open/save commands or advertises capabilities until hostReady(). */
export function prepareHost(app: string, version: string) {
  if (app === "wordcraft" || app === "deckcraft") {
    // Both apps bind Copy Formatting. Don't let the browser's inspector steal its key/focus.
    // The event still reaches eframe; only the browser's default action is cancelled.
    window.addEventListener("keydown", (event) => {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey && event.code === "KeyC")
        event.preventDefault();
    }, true);
  }

  if (!hostRequested()) return false;

  if (protocol) throw new Error("Native host preparation is single-use per iframe");

  // The host sandboxes this frame into an opaque origin, so editor code holds none of the host's
  // authority: no host DOM, storage or cookies. Only the origin serving this page may frame it
  // (`frame-ancestors 'self'`); messages go to that origin alone and come only from it.
  if (window.parent === window || window.origin !== "null")
    throw new Error("Native host requires a framed, sandboxed opaque-origin document");
  const config = configurations.get(app);

  if (!config) throw new Error("Unknown native engine configuration");
  protocol = createNativeHostProtocol({
    ...config,
    version,
    origin: window.location.origin,
    parent: window.parent,
    post: (message, origin) => window.parent.postMessage(message, origin),
    repaint: () => repaint?.(),
  });
  window.addEventListener("message", (event) =>
    bridge().receive({ origin: event.origin, source: event.source, data: event.data }),
  );
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => repaint?.());

  return true;
}

export function hostCanExport(name: string) {
  return bridge().canExport(name);
}

export function hostHasPendingSave() {
  return bridge().hasPendingSave();
}

export function hostHasRecoverySnapshot() {
  return bridge().hasRecoverySnapshot();
}

export function hostSystemDark() {
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function attachHostRepaint(callback: () => void) {
  repaint = callback;
}

export function hostReady() {
  bridge().ready();
}

export function hostFailed(message: string) {
  bridge().failed(message);
}

export function hostDetached(message: string) {
  bridge().detached(message);
}

export function hostTakeOpen() {
  return bridge().takeOpen();
}

export function hostOpened(openId: string, documentId: string, revision: string) {
  bridge().opened(openId, documentId, revision);
}

export function hostOpenFailed(openId: string, message: string) {
  bridge().openFailed(openId, message);
}

export function hostObserved(documentId: string, revision: string, dirty: boolean) {
  bridge().observe(documentId, revision, dirty);
}

export function hostSaveRequested(
  documentId: string,
  saveAs: boolean,
  name?: string,
  intentId?: string,
) {
  return bridge().saveRequested(documentId, saveAs, name, intentId);
}

export function hostTakeSaveRequest() {
  return bridge().takeSaveRequest();
}

/** Called only with bytes/revision captured by the Rust serializer, never parent-supplied bytes. */
export function hostSerialized(
  requestId: string,
  documentId: string,
  revision: string,
  name: string,
  bytes: Uint8Array,
  saveAs: boolean,
) {
  return bridge().serialized({ requestId, documentId, revision, name, bytes, saveAs });
}

export function hostSerializationFailed(requestId: string, code: NativeErrorCode, message: string) {
  bridge().serializationFailed(requestId, code, message);
}

/** Drain cancellation/failure fences before hostTakeAcknowledgement in each native frame. */
export function hostTakeCancellation() {
  return bridge().takeCancellation();
}

export function hostTakeFailure() {
  return bridge().takeFailure();
}

export function hostTakeDiscard() {
  return bridge().takeDiscard();
}

export function hostTakeAcknowledgement() {
  return bridge().takeAcknowledgement();
}

/** Native pre-apply guard and post-apply currentRevision are intentionally separate (PDF). */
export function hostAcknowledged(
  beforeDocumentId: string | null,
  beforeRevision: string,
  currentDocumentId: string | null,
  currentRevision: string,
  dirty: boolean,
) {
  bridge().acknowledged(
    beforeDocumentId,
    beforeRevision,
    currentDocumentId,
    currentRevision,
    dirty,
  );
}

export function hostTakeThemeRequest() {
  return bridge().takeThemeRequest();
}

export function hostThemeFailed(requestId: string, message: string) {
  bridge().themeFailed(requestId, message);
}

/** The largest print the frame may open: the engines' own document ceiling. */
const MAX_PRINT_BYTES = 64 * 1024 * 1024;

/**
 * Hosted print for Word and Grid: the PDF is downloaded, and the person prints it from their PDF
 * viewer. Every `/artcraft` page is sandboxed by its own response, and a PDF tab opened from here
 * would inherit that sandbox, which browsers refuse to show a PDF in. Anything without the PDF
 * signature is refused rather than handed over.
 */
export function hostShowPdf(bytes: Uint8Array) {
  const signature = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

  if (
    bytes.byteLength > MAX_PRINT_BYTES ||
    !signature.every((byte, index) => bytes[index] === byte)
  )
    throw new Error("Print output is not a PDF");

  const url = URL.createObjectURL(new Blob([bytes.slice()], { type: "application/pdf" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "Print.pdf";
  link.click();
  // Long enough for the download to start; it keeps its own copy after that.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export function hostThemeApplied(
  requestId: string,
  theme: NativeTheme,
  resolvedTheme: "light" | "dark",
) {
  bridge().themeApplied(requestId, theme, resolvedTheme);
}
