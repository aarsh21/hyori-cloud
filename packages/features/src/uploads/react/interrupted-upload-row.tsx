import type { UploadEntry } from "@hyori-cloud/client-sdk";
import { useRef } from "@hyori-cloud/lib/react";
import { X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { UploadIntentTag } from "#features/uploads/react/upload-intent-tag.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";
import { describeCancelFailure } from "#features/uploads/upload-failure-copy.ts";

type InterruptedUpload = Extract<UploadEntry, { state: "interrupted" }>;

// The file to choose goes by its own name on this device, which a new version's target may not share.
function interruptedDetail({ checkpoint, error }: InterruptedUpload) {
  const localName = checkpoint.file.name;

  if (error === null) return `Interrupted. Choose “${localName}” again to continue.`;

  if (error.code === "SDK_FILE_MISMATCH") {
    return `That isn’t the same file. Choose “${localName}”, unchanged, to continue.`;
  }

  const copy = describeCloudError(error);

  // A saved upload that can no longer be resumed, which was refused before any request.
  if (error.code === "SDK_VALIDATION") return copy.detail ?? copy.title;

  // Otherwise a discard the server didn't confirm.
  return describeCancelFailure(error, copy);
}

/** After a reload the browser no longer holds the file, so resuming means choosing it again. */
export function InterruptedUploadRow({ entry }: { entry: InterruptedUpload }) {
  const { id, intent, error, cancelling = false } = entry;
  const queue = useUploadQueue();
  const picker = useRef<FilePickerHandle>(null);
  const { name } = intent;

  return (
    <TransferItem
      name={name}
      tag={<UploadIntentTag intent={intent} />}
      tone={error === null ? "default" : "destructive"}
      wrapDetail={!cancelling}
      detail={cancelling ? "Cancelling…" : interruptedDetail(entry)}
      actions={
        <>
          <FilePicker
            ref={picker}
            multiple={false}
            onFiles={([file]) => file && queue.resume(id, file)}
          />
          <Button
            size="xs"
            variant="outline"
            disabled={cancelling}
            onClick={() => picker.current?.open()}
          >
            Choose file
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={`Discard upload of ${name}`}
            disabled={cancelling}
            onClick={() => void queue.cancel(id).catch(() => undefined)}
          >
            <X />
          </Button>
        </>
      }
    />
  );
}
