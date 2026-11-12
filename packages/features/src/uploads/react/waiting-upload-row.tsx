import type { UploadIntent } from "@hyori-cloud/client-sdk";
import { X } from "@hyori-cloud/lib/icons";
import { Button } from "@hyori-cloud/ui/components/button";
import { Progress } from "@hyori-cloud/ui/components/progress";
import { TransferItem } from "@hyori-cloud/ui/components/transfer-tray";
import { UploadIntentTag } from "#features/uploads/react/upload-intent-tag.tsx";
import { useUploadQueue } from "#features/uploads/react/uploads-provider.tsx";

export function WaitingUploadRow({ id, intent }: { id: string; intent: UploadIntent }) {
  const queue = useUploadQueue();
  const { name } = intent;

  return (
    <TransferItem
      name={name}
      tag={<UploadIntentTag intent={intent} />}
      detail="Waiting"
      progress={<Progress value={0} label={`Upload progress for ${name}`} />}
      actions={
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove ${name}`}
          onClick={() => void queue.cancel(id).catch(() => undefined)}
        >
          <X />
        </Button>
      }
    />
  );
}
