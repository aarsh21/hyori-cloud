import { Button } from "@hyori-cloud/ui/components/button";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Row } from "@hyori-cloud/ui/components/text";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";

/** Pagination feedback lives at the continuation: loaded rows are never hidden or implied failed. */
export function LoadMore({
  pages,
}: {
  pages: {
    readonly hasNextPage: boolean;
    readonly isFetchingNextPage: boolean;
    readonly isFetchNextPageError: boolean;
    readonly error: CloudError | null;
    readonly fetchNextPage: () => void;
  };
}) {
  const failure = pages.isFetchNextPageError ? pages.error : null;
  const recovery = useAccessRecovery(failure);

  if (!pages.hasNextPage) return null;

  if (failure !== null) {
    const copy = recovery ?? describeCloudError(failure);

    return (
      <Notice
        title={`Couldn’t load more. ${copy.title}.`}
        action={
          recovery === null ? (
            <Button
              size="sm"
              variant="outline"
              pending={pages.isFetchingNextPage}
              pendingLabel="Retrying…"
              onClick={() => pages.fetchNextPage()}
            >
              Try again
            </Button>
          ) : (
            <AccessRecoveryButton recovery={recovery} size="sm" />
          )
        }
      />
    );
  }

  return (
    <Row className="justify-center py-1">
      <Button
        variant="ghost"
        pending={pages.isFetchingNextPage}
        pendingLabel="Loading…"
        onClick={() => pages.fetchNextPage()}
      >
        Load more
      </Button>
    </Row>
  );
}
