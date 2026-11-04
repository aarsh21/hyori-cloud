"use client";

import { useSyncExternalStore } from "@hyori-cloud/lib/react";
import type { UploadQueue } from "#client-sdk/features/uploads/upload-queue";

export function useUploadEntries(queue: UploadQueue) {
  return useSyncExternalStore(queue.subscribe, queue.getEntries, queue.getServerEntries);
}

export function useUploadSummary(queue: UploadQueue) {
  return useSyncExternalStore(queue.subscribe, queue.getSummary, queue.getServerSummary);
}
