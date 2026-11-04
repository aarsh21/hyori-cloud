/** Hands a capability URL to the browser's own download manager, which streams to disk. */
export function startBrowserDownload(url: string, name: string) {
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  anchor.style.display = "none";
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
}

/** Client-side navigation leaves focus on a removed element; this gives keyboard users a next Tab. */
export function focusMainRegion() {
  document.querySelector<HTMLElement>('[data-slot="app-main"]')?.focus({ preventScroll: true });
}

/** True for a bare keypress meant for the app: not typing, not chorded, no modal or menu open. */
export function isAppShortcut(event: KeyboardEvent) {
  if (event.metaKey || event.ctrlKey || event.altKey) return false;
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
