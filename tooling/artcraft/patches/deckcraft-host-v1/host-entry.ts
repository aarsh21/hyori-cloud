import { createDeckHostProtocol } from "./host-protocol.ts";

let protocol: ReturnType<typeof createDeckHostProtocol> | null = null;

export function hostRequested(): boolean {
  return new URLSearchParams(window.location.search).get("host") === "parent";
}

export function initializeHost(version: string, repaint: () => void): boolean {
  if (!hostRequested()) return false;

  if (protocol) throw new Error("Host bridge already initialized");

  const parent = window.parent;
  const origin = window.location.origin;

  if (parent === window || origin === "null" || parent.location.origin !== origin)
    throw new Error("Host mode requires an exact same-origin parent window");

  protocol = createDeckHostProtocol({
    version,
    parent,
    origin,
    repaint,
    post: (message, targetOrigin) => parent.postMessage(message, targetOrigin),
  });
  const bridge = protocol;
  window.addEventListener("message", (event) => bridge.receive(event));

  return true;
}

function bridge() {
  if (!protocol) throw new Error("Host bridge is not initialized");

  return protocol;
}

export function hostReady() {
  bridge().ready();
}

export function hostTakeOpen() {
  return bridge().takeOpen();
}

export function hostOpened(openId: string, documentId: string) {
  bridge().opened(openId, documentId);
}

export function hostOpenFailed(openId: string, error: string) {
  bridge().openFailed(openId, error);
}

export function hostSave(documentId: string, name: string, bytes: Uint8Array, saveAs: boolean) {
  return bridge().save(documentId, name, bytes, saveAs);
}

export function hostTakeAcknowledgement() {
  return bridge().takeAcknowledgement();
}

export function hostConfirmSaved(saveId: string, dirty: boolean) {
  bridge().confirmSaved(saveId, dirty);
}

export function hostDirty(dirty: boolean) {
  bridge().dirty(dirty);
}

export function hostFailed(error: string) {
  if (protocol) protocol.failed(error);
}

export function hostReportError(error: string) {
  bridge().reportError(error);
}

export function hostTakeLocalError() {
  return bridge().takeLocalError();
}
