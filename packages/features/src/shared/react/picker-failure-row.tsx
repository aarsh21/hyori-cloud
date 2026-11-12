import { Button } from "@hyori-cloud/ui/components/button";
import { PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { InlineText } from "@hyori-cloud/ui/components/text";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** A failed list inside a dialog's fixed-height picker. Recovery depends on what actually failed. */
export function PickerFailureRow({ error, onRetry }: { error: CloudError; onRetry: () => void }) {
  const recovery = useAccessRecovery(error);

  return (
    <PickerRow className="justify-between px-2 hover:bg-transparent">
      <InlineText tone="destructive" truncate>
        {(recovery ?? describeCloudError(error)).title}
      </InlineText>
      {recovery === null ? (
        <Button type="button" size="xs" variant="outline" onClick={() => onRetry()}>
          Try again
        </Button>
      ) : (
        <AccessRecoveryButton recovery={recovery} size="xs" />
      )}
    </PickerRow>
  );
}
