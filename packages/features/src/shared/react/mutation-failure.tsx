import { Notice } from "@hyori-cloud/ui/components/notice";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError, ErrorCopy } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Stays beside the form or action that failed. The user's input and the content are untouched. */
export function MutationFailure({
  error,
  onRecovered,
  describe = describeCloudError,
}: {
  error: CloudError | null;
  onRecovered?: () => void;
  /** An operation whose failures mean something more specific than the generic copy. */
  describe?: (error: CloudError) => ErrorCopy;
}) {
  const recovery = useAccessRecovery(error);

  if (error === null) return null;
  const copy = recovery ?? describe(error);

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
