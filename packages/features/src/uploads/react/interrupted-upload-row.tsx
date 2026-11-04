import type { UploadEntry } from "@hyori-cloud/client-sdk";
import { useRef } from "@hyori-cloud/lib/react";
import { X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { FilePicker } from "@hyori-cloud/ui/components/file-picker";
import type { FilePickerHandle } from "@hyori-cloud/ui/components/file-picker";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { formatBytes } from "#features/shared/format.ts";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

type InterruptedUpload = Extract<UploadEntry, { state: "interrupted" }>;

// An error here is either a wrong file reselection or a discard the server didn't confirm.
function interruptedDetail({ checkpoint, error }: InterruptedUpload) {
  if (error === null) return `Interrupted · ${formatBytes(checkpoint.file.size)}`;
  const copy = describeCloudError(error);

  return copy.detail ?? copy.title;
}

/** After a reload the browser no longer holds the file, so resuming means choosing it again. */
export function InterruptedUploadRow({ entry }: { entry: InterruptedUpload }) {
  const { id, checkpoint, error, cancelling = false } = entry;
  const queue = useUploadQueue();
  const picker = useRef<FilePickerHandle>(null);
  const name = checkpoint.file.name;

  return (
    <TransferItem
      name={name}
      tone={error === null ? "default" : "destructive"}
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
