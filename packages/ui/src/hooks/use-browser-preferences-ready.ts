import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const serverReady = () => false;

const clientReady = () =>
  document.documentElement.hasAttribute("data-local-preferences") ||
  document.documentElement.hasAttribute("data-local-desktop-preferences") ||
  document.documentElement.hasAttribute("data-local-shortcuts-off");

/** Only marked browsers need a reveal render; matching choices keep their immediate server paint.
 * Read alongside the preference owner so its client snapshot commits before the surface appears.
 */
export function useBrowserPreferencesReady() {
  return useSyncExternalStore(subscribe, clientReady, serverReady);
}
