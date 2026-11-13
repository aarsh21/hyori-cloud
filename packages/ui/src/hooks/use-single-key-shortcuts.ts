import {
  readSingleKeyShortcuts,
  subscribeSingleKeyShortcuts,
} from "@hyori-cloud/ui/lib/single-key-shortcuts";
import { useSyncExternalStore } from "react";
import { useServerBrowserPreferences } from "@hyori-cloud/ui/components/browser-preferences-provider";

export function useSingleKeyShortcuts() {
  const preferences = useServerBrowserPreferences();

  return useSyncExternalStore(
    subscribeSingleKeyShortcuts,
    readSingleKeyShortcuts,
    () => preferences.singleKeyShortcuts,
  );
}
