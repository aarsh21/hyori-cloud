"use client";

import { useSyncExternalStore } from "@hyori-cloud/lib/react";
import type { EditorSession } from "#client-sdk/features/editors/editor-contract";

/** Observe the owned local controller without duplicating its frame or persistence lifecycle. */
export function useEditorSession(session: EditorSession) {
  return useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
}
