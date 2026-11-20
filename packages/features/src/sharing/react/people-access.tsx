import type { FileEntry, Share, ShareRole } from "@hyori-cloud/client-sdk";
import { useMemo, useState } from "@hyori-cloud/lib/react";
import { Avatar, AvatarFallback } from "@hyori-cloud/ui/components/avatar";
import { Button } from "@hyori-cloud/ui/components/button";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText, Row, SectionHeading, Stack } from "@hyori-cloud/ui/components/text";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { useAuthStatus } from "#features/auth/react/use-auth-status.ts";
import type { FailedShareAction } from "#features/sharing/react/share-action-notice.tsx";
import { ShareActionNotice } from "#features/sharing/react/share-action-notice.tsx";
import { RecipientPicker } from "#features/sharing/react/recipient-picker.tsx";
import { ShareRoleSelect } from "#features/sharing/react/share-role-select.tsx";
import {
  isPendingShare,
  patchShareRole,
  upsertShare,
  useSharesCache,
  withoutShare,
} from "#features/sharing/react/shares-cache.ts";
import { SHARE_ROLE_LABELS } from "#features/sharing/share-roles.ts";
import {
  useCreateShare,
  useRevokeShare,
  useUpdateShare,
} from "#features/sharing/react/use-shares.ts";

export function PeopleAccess({
  entry,
  shares,
}: {
  entry: FileEntry;
  /** This item's account shares, including any grant still in flight. */
  shares: readonly Share[];
}) {
  const auth = useAuthStatus();
  const owner = auth.data?.user;

  const excludedIds = useMemo(() => excludedIdsOf(entry.ownerId, shares), [entry.ownerId, shares]);
  const cache = useSharesCache(entry.id);
  const revoke = useRevokeShare();
  const create = useCreateShare();

  // One notice speaks for the section, whichever person's action failed last.
  const [failure, setFailure] = useState<FailedShareAction | null>(null);

  // Removal and its undo belong to the section, not the row: the row leaves the list
  // optimistically before the server answers, and a mutation's per-call callbacks only run
  // while a component subscribed to it is still mounted.
  function removePerson(share: Share) {
    const name = personName(share);

    void cache.snapshot().then(() => cache.amend((page) => withoutShare(page, share.id)));
    revoke.mutate(
      { id: share.id },
      {
        onError(error) {
          cache.amend((page) => upsertShare(page, share));
          setFailure({
            title: `Couldn’t remove ${name}`,
            error,
            retry: () => removePerson(share),
          });
        },
        onSuccess() {
          toast(`Removed ${name}’s access`, {
            duration: 6000,
            action: { label: "Undo", onClick: () => restorePerson(share) },
          });
        },
      },
    );
  }

  // Revoked access leaves no share behind to modify, so Undo grants the same person the same role
  // again as a new share.
  function restorePerson(share: Share) {
    if (share.recipientId === null) return;

    const name = personName(share);

    create.mutate(
      { itemId: entry.id, role: share.role, public: false, recipientId: share.recipientId },
      {
        onError(error) {
          toast.error(`Couldn’t restore ${name}’s access`, {
            description: describeCloudError(error).title,
            action: { label: "Try again", onClick: () => restorePerson(share) },
          });
        },
      },
    );
  }

  return (
    <Stack className="gap-3">
      <SectionHeading>People</SectionHeading>
      <RecipientPicker entry={entry} excludedIds={excludedIds} />
      {owner?.id === entry.ownerId ? (
        <Row className="min-h-11 items-center gap-2.5 px-1">
          <Avatar className="size-7">
            <AvatarFallback name={owner.name} />
          </Avatar>
          <Stack className="min-w-0 flex-1 gap-0">
            <InlineText className="truncate font-medium">You</InlineText>
            <InlineText className="truncate text-muted-foreground">{owner.email}</InlineText>
          </Stack>
          <Tag>Owner</Tag>
        </Row>
      ) : null}
      <Stack className="gap-1" role="list" aria-label="Who has access">
        {shares.map((share) => (
          <PersonRow
            key={share.id}
            entry={entry}
            share={share}
            removing={revoke.isPending && revoke.variables?.id === share.id}
            onRemove={removePerson}
            onFailure={setFailure}
          />
        ))}
      </Stack>
      {failure === null ? null : (
        <ShareActionNotice
          title={failure.title}
          error={failure.error}
          onRetry={failure.retry}
          onDismiss={() => setFailure(null)}
        />
      )}
    </Stack>
  );
}

function excludedIdsOf(
  ownerId: FileEntry["ownerId"],
  shares: readonly Share[],
): ReadonlySet<string> {
  const ids = new Set<string>([ownerId]);

  for (const share of shares) {
    if (share.recipientId !== null) ids.add(share.recipientId);
  }

  return ids;
}

function personName(share: Share): string {
  return share.recipient?.name ?? share.recipientId ?? "this person";
}

function PersonRow({
  entry,
  share,
  removing,
  onRemove,
  onFailure,
}: {
  entry: FileEntry;
  share: Share;
  removing: boolean;
  onRemove: (share: Share) => void;
  onFailure: (failure: FailedShareAction) => void;
}) {
  const cache = useSharesCache(entry.id);
  const update = useUpdateShare();
  const person = share.recipient;
  const name = personName(share);
  // The picker already shows this grant in flight; its role and removal only apply once it settles.
  const pending = isPendingShare(share);

  function changeRole(role: ShareRole) {
    void cache.snapshot().then(() => cache.amend((page) => patchShareRole(page, share.id, role)));
    update.mutate(
      { id: share.id, role },
      {
        onError(error) {
          cache.amend((page) => patchShareRole(page, share.id, share.role));
          onFailure({
            title: `Couldn’t change ${name} to ${SHARE_ROLE_LABELS[role]}`,
            error,
            retry: () => changeRole(role),
          });
        },
      },
    );
  }

  return (
    <Row className="min-h-11 items-center gap-2.5 px-1" role="listitem">
      <Avatar className="size-7">
        <AvatarFallback name={name} />
      </Avatar>
      <Stack className="min-w-0 flex-1 gap-0">
        <InlineText className="truncate font-medium">{name}</InlineText>
        {person === null ? null : (
          <InlineText className="truncate text-muted-foreground">{person.email}</InlineText>
        )}
      </Stack>
      {pending ? (
        <Tag>{SHARE_ROLE_LABELS[share.role]}</Tag>
      ) : (
        <ShareRoleSelect
          label={`${name}’s role`}
          className="w-32 shrink-0"
          value={share.role}
          onChange={changeRole}
        />
      )}
      {pending ? null : (
        <Button
          size="sm"
          variant="ghost"
          pending={removing}
          pendingLabel="Removing…"
          onClick={() => onRemove(share)}
        >
          Remove
        </Button>
      )}
    </Row>
  );
}
