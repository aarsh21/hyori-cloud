import { Notice } from "@hyori-cloud/ui/components/notice";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Stays beside the form or action that failed. The user's input and the content are untouched. */
export function MutationFailure({
  error,
  onRecovered,
}: {
  error: CloudError | null;
  onRecovered?: () => void;
}) {
  const recovery = useAccessRecovery(error);

  if (error === null) return null;
  const copy = recovery ?? describeCloudError(error);

  return (
    <Notice
      title={copy.title}
      action={
        recovery === null ? undefined : (
          <AccessRecoveryButton recovery={recovery} size="sm" onRecovered={onRecovered} />
        )
      }
    >
      {copy.detail}
    </Notice>
  );
}
