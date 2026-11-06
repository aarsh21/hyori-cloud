import {
  readItemLayout,
  subscribeItemLayout,
  writeItemLayout,
} from "@hyori-cloud/ui/lib/item-layout-preference";
import type { ItemLayout } from "@hyori-cloud/ui/lib/item-layout-preference";
import { useSyncExternalStore } from "react";

function serverItemLayout(): ItemLayout {
  return "list";
}

/** List or grid survives moving between screens and reloading, like the sidebar does. */
export function useItemLayout() {
  const layout = useSyncExternalStore(subscribeItemLayout, readItemLayout, serverItemLayout);

  return [layout, writeItemLayout] as const;
}
