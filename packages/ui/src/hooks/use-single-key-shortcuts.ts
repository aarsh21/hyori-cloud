import {
  readSingleKeyShortcuts,
  subscribeSingleKeyShortcuts,
} from "@hyori-cloud/ui/lib/single-key-shortcuts";
import { useSyncExternalStore } from "react";

function serverSingleKeyShortcuts() {
  return true;
}

export function useSingleKeyShortcuts() {
  return useSyncExternalStore(
    subscribeSingleKeyShortcuts,
    readSingleKeyShortcuts,
    serverSingleKeyShortcuts,
  );
}
