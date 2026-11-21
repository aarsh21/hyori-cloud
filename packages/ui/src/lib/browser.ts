import { readSingleKeyShortcuts } from "@hyori-cloud/ui/lib/single-key-shortcuts";

/** Server attachments name themselves. Only a local Blob needs a download attribute:
 * WebKit omits same-origin request metadata when that attribute forces a network download. */
export function startBrowserDownload(url: string, name?: string) {
  const anchor = document.createElement("a");
  anchor.href = url;

  if (name !== undefined) anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Client-side navigation leaves focus on a removed element; this gives keyboard users a next Tab. */
/** Hands bytes already in memory to the browser's download manager. */
export function saveBytesAsDownload(bytes: Uint8Array<ArrayBuffer>, name: string) {
  const url = URL.createObjectURL(new Blob([bytes]));

  startBrowserDownload(url, name);
  // Long enough for the browser to have taken its own reference.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

type ConnectionNavigator = Navigator & {
  readonly connection?: { readonly saveData?: boolean; readonly effectiveType?: string };
};

/**
 * True when the browser asks to save data or reports a 2G connection. Chromium-only signals:
 * elsewhere they are absent and this is false, so a speculative download only skips where asked.
 */
export function isConstrainedConnection(host: ConnectionNavigator = navigator) {
  const connection = host.connection;

  return (
    connection?.saveData === true ||
    connection?.effectiveType === "2g" ||
    connection?.effectiveType === "slow-2g"
  );
}

export function focusMainRegion() {
  document.querySelector<HTMLElement>('[data-slot="app-main"]')?.focus({ preventScroll: true });
}

/**
 * True for a bare keypress meant for the app: not typing, not chorded, no modal or menu open. A
 * stray key can trigger these, and speech input can type them, so they can be turned off.
 */
export function isAppShortcut(event: KeyboardEvent) {
  if (!readSingleKeyShortcuts() || event.metaKey || event.ctrlKey || event.altKey) return false;
  const target = event.target;

  if (
    target instanceof HTMLElement &&
    (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
  ) {
    return false;
  }

  return (
    document.querySelector(
      '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
    ) === null
  );
}

/**
 * `navigator.clipboard` doesn't exist outside secure contexts, including plain-HTTP self-hosted
 * installs. Being async turns that into a rejection, so callers have one failure path.
 */
export async function copyText(text: string) {
  await navigator.clipboard.writeText(text);
}
