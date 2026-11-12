import type { NativeErrorCode, NativeTheme } from "@hyori-cloud/client-sdk/editor-runtime";
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

/** Prepare before WebRunner startup, so native initialization failure has a real error surface.
 * Nothing accepts open/save commands or advertises capabilities until hostReady(). */
export function prepareHost(app: string, version: string) {
  if (!hostRequested()) return false;

  if (protocol) throw new Error("Native host preparation is single-use per iframe");

  if (
    window.parent === window ||
    window.location.origin === "null" ||
    window.parent.location.origin !== window.location.origin
  )
    throw new Error("Native host requires a framed exact same-origin parent");
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

export function hostThemeApplied(
  requestId: string,
  theme: NativeTheme,
  resolvedTheme: "light" | "dark",
) {
  bridge().themeApplied(requestId, theme, resolvedTheme);
}
