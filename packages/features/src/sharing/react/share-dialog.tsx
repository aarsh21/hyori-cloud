import type { FileEntry } from "@hyori-cloud/client-sdk";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Notice } from "@hyori-cloud/ui/components/notice";
import { Skeleton } from "@hyori-cloud/ui/components/skeleton";
import { Stack } from "@hyori-cloud/ui/components/text";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import {
  AccessRecoveryButton,
  useAccessRecovery,
} from "#features/shared/react/access-recovery.tsx";
import { RefreshFailure } from "#features/shared/react/refresh-failure.tsx";
import { LinkShares } from "#features/sharing/react/link-shares.tsx";
import { PeopleAccess } from "#features/sharing/react/people-access.tsx";
import { useItemShares } from "#features/sharing/react/use-shares.ts";

export function ShareDialog({
  entry,
  open,
  onOpenChange,
}: {
  entry: FileEntry;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shares = useItemShares(entry.id, open);
  let description = "Only you can delete this file, whatever role you give.";

  if (entry.mimeType === "application/vnd.hyori.note")
    description = "Applies to this note and its nested notes. Only you can delete.";
  else if (entry.kind === "folder")
    description = "Applies to everything inside, including future uploads. Only you can delete.";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>Share “{entry.name}”</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-5">
          <ShareDialogBody entry={entry} shares={shares} />
        </DialogBody>
        <DialogFooter>
          <DialogClose render={<Button variant="ghost" type="button" />}>Done</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ShareDialogBody({
  entry,
  shares,
}: {
  entry: FileEntry;
  shares: ReturnType<typeof useItemShares>;
}) {
  const recovery = useAccessRecovery(shares.error);

  if (shares.data === undefined) {
    if (shares.error !== null) {
      const copy = recovery ?? describeCloudError(shares.error);

      return (
        <Notice
          title={copy.title}
          action={
            recovery === null ? (
              <Button size="sm" variant="outline" onClick={() => shares.refetch()}>
                Try again
              </Button>
            ) : (
              <AccessRecoveryButton recovery={recovery} size="sm" />
            )
          }
        >
          {copy.detail}
        </Notice>
      );
    }

    return (
      <Stack className="gap-3" aria-hidden>
        <Skeleton className="h-3 w-16" />
        <Skeleton className="h-8" />
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-8" />
      </Stack>
    );
  }

  return (
    <>
      {shares.error === null ? null : (
        <RefreshFailure error={shares.error} onRetry={() => shares.refetch()} />
      )}
      <PeopleAccess entry={entry} shares={shares.data.items.filter((share) => !share.public)} />
      <LinkShares
        itemId={entry.id}
        itemName={entry.name}
        inheritsAccess={entry.parentId !== null}
        shares={shares.data.items.filter((share) => share.public)}
      />
    </>
  );
}
