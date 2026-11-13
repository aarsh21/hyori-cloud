import {
  readItemLayout,
  subscribeItemLayout,
  writeItemLayout,
} from "@hyori-cloud/ui/lib/item-layout-preference";
import { useServerBrowserPreferences } from "@hyori-cloud/ui/components/browser-preferences-provider";
import { useSyncExternalStore } from "react";

/** List or grid survives moving between screens and reloading, like the sidebar does. */
export function useItemLayout() {
  const preferences = useServerBrowserPreferences();

  const layout = useSyncExternalStore(
    subscribeItemLayout,
    readItemLayout,
    () => preferences.layout,
  );

  return [layout, writeItemLayout] as const;
}
