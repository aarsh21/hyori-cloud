import type { CloudError } from "#features/shared/cloud-error.ts";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { Button } from "@hyori-cloud/ui/components/button";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Row } from "@hyori-cloud/ui/components/text";

/**
 * A sharing action that rolled back, kept with what it takes to offer it again. Kept in state by
 * the section it happened in, so one notice speaks for whichever row or picker action failed last.
 */
export type FailedShareAction = {
  title: string;
  error: CloudError;
  retry: () => void;
};

/**
 * What an optimistic sharing action reports when the server turns it down. The change has already
 * rolled back beside it, so this only names the person, says what to do, and offers the same
 * action again.
 */
export function ShareActionNotice({
  title,
  error,
  onRetry,
  onDismiss,
}: {
  title: string;
  error: CloudError;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const copy = describeCloudError(error);

  return (
    <Notice
      title={title}
      action={
        <Row className="gap-1">
          <Button size="sm" variant="outline" onClick={onRetry}>
            Try again
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>
            Dismiss
          </Button>
        </Row>
      }
    >
      {copy.detail ?? copy.title}
    </Notice>
  );
}
