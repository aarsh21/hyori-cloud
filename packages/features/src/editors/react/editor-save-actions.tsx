import type { EditorSession, EditorSnapshot } from "@hyori-cloud/client-sdk";
import { Button } from "@hyori-cloud/ui/components/button";

/** Intent controls only; SDK state decides availability, serialization and durable persistence. */
export function EditorSaveActions({
  snapshot,
  requestSave,
  onCopy,
}: {
  snapshot: EditorSnapshot;
  requestSave: EditorSession["requestSave"];
  onCopy: () => void;
}) {
  const document = snapshot.document;

  if (document?.bridge !== "hyori-correlated-host-v3" || document.protocol !== 3) return null;

  if (
    snapshot.status !== "editing" &&
    snapshot.status !== "read-only" &&
    snapshot.status !== "saving"
  )
    return null;
  const serializing = snapshot.autosave.status === "serializing";
  const pending = serializing || snapshot.status === "saving";

  const detached =
    snapshot.autosave.status === "disabled" && snapshot.autosave.reason === "copy-required";

  if (detached || !document.writable || document.replacementName === null) {
    return (
      <Button size="sm" variant="outline" pending={pending} pendingLabel="Saving…" onClick={onCopy}>
        Save a copy
      </Button>
    );
  }

  const serializationFailed =
    snapshot.autosave.status === "paused" && snapshot.autosave.reason === "serialization-failed";

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={!snapshot.hasUnsavedChanges}
      pending={pending}
      pendingLabel={serializing ? "Preparing…" : "Saving…"}
      onClick={() => requestSave()}
    >
      {serializationFailed ? "Try saving again" : "Save"}
    </Button>
  );
}
