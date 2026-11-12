import { useSyncExternalStore } from "@hyori-cloud/lib/react";

const subscribe = () => () => {};
const clientReady = () => true;
const serverReady = () => false;

/** Keep the server and first browser render identical, then enable browser-owned interactions. */
export function useHydrated() {
  return useSyncExternalStore(subscribe, clientReady, serverReady);
}
