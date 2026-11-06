import type { EditorSnapshot } from "@hyori-cloud/client-sdk";

/** Presentation only: the SDK remains the sole owner of save and autosave transitions. */
export function editorSaveState(snapshot: EditorSnapshot): string {
  switch (snapshot.status) {
    case "opening":
      return "Opening…";
    case "saving":
      return "Saving…";
    case "save-failed":
      return "Not saved";
    case "conflict":
      return "Not saved: save conflict";
    case "access-ended":
      return "Access ended";
    case "failed":
      return "Editor stopped";
    case "disposed":
      return "Closed";
    case "read-only":
      if (snapshot.autosave.status === "disabled" && snapshot.autosave.reason === "copy-required")
        return "Save a copy to keep changes";

      return snapshot.document?.writable === false ? "Read only" : "Save a copy to keep changes";
    case "editing": {
      const { autosave } = snapshot;

      switch (autosave.status) {
        case "waiting":
          return "Waiting for current edit…";
        case "scheduled":
          return "Saving soon…";
        case "serializing":
          return "Preparing to save…";
        case "idle":
          if (snapshot.hasUnsavedChanges) return "Unsaved changes";

          return snapshot.lastSavedAt === null ? "Ready to edit" : "All changes saved";
        case "paused":
          return autosave.reason === "serialization-failed"
            ? "Not saved: couldn’t prepare changes"
            : "Autosave paused";
        case "disabled":
          if (autosave.reason === "copy-required") return "Save a copy to keep changes";

          if (autosave.reason === "read-only") return "Read only";

          return snapshot.hasUnsavedChanges ? "Unsaved changes" : "All changes saved";
      }

      autosave satisfies never;

      return "";
    }
  }

  snapshot.status satisfies never;

  return "";
}
