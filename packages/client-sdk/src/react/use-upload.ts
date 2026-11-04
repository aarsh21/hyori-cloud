"use client";

import { useSyncExternalStore } from "@hyori-cloud/lib/react";
import type { UploadTask } from "#client-sdk/features/uploads/upload";

/** React only observes the vanilla lifecycle; it owns no transfer protocol or effects. */
export function useUpload(task: UploadTask) {
  return useSyncExternalStore(task.subscribe, task.getSnapshot, task.getSnapshot);
}
