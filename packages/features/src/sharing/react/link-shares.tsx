import type { Share, ShareRole } from "@hyori-cloud/client-sdk";
import { Link2 } from "@hyori-cloud/lib/icons";
import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { LinkField } from "@hyori-cloud/ui/components/copy-button";
import { Field, FieldDescription, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText, Row, SectionHeading, Stack, Text } from "@hyori-cloud/ui/components/text";
import { endOfLocalDayIso, formatDate, localDateInputValue } from "#features/shared/format.ts";
import { formText, optionalFormText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { ShareRoleSelect } from "#features/sharing/react/share-role-select.tsx";
import { RevokeLinkDialog } from "#features/sharing/react/revoke-link-dialog.tsx";
import { useCreateShare, useRevokeShare } from "#features/sharing/react/use-shares.ts";
import { SHARE_ROLE_LABELS } from "#features/sharing/share-roles.ts";

/** Access stays restricted until someone explicitly creates a link. */
export function LinkShares({
  itemId,
  itemName,
  inheritsAccess,
  shares,
}: {
  itemId: string;
  itemName: string;
  /** Sharing on a parent folder reaches this item too, and this list only shows its direct links. */
  inheritsAccess: boolean;
  shares: readonly Share[];
}) {
  const [composing, setComposing] = useState(false);
  const [role, setRole] = useState<ShareRole>("viewer");
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const create = useCreateShare();
  const revoke = useRevokeShare();

  // The server keeps only a hash of the token, so the URL exists solely in this response. This is a
  // real copy because a mutation forgets its result as soon as another starts: a failed second link
  // or list refresh mustn't lose the only chance to copy this one. It ends with the dialog's popup.
  const [issued, setIssued] = useState<{ readonly id: string; readonly url: string } | null>(null);
  const issuedUrl = issued?.url ?? null;
  const confirmingRevoke = shares.find((share) => share.id === confirmingRevokeId);
  // A date input's minimum, read once: an already-past expiry would make a link that never works.
  const [today] = useState(() => localDateInputValue(new Date()));

  function closeComposer() {
    setComposing(false);
    setRole("viewer");
    create.reset();
  }

  function revokeConfirmed() {
    if (confirmingRevokeId === null) return;

    revoke.mutate(
      { id: confirmingRevokeId },
      {
        onSuccess() {
          if (issued?.id === confirmingRevokeId) setIssued(null);
        },
        onSettled: () => setConfirmingRevokeId(null),
      },
    );
  }

  return (
    <Stack className="gap-2.5">
      <Row className="min-h-7 justify-between gap-2">
        <SectionHeading>Public links</SectionHeading>
        {composing ? null : (
          <Button size="sm" variant="outline" onClick={() => setComposing(true)}>
            <Link2 aria-hidden />
            Create link
          </Button>
        )}
      </Row>

      {issuedUrl !== null ? (
        <Stack className="gap-1.5">
          <LinkField value={issuedUrl} label="Public link" />
          <Text size="xs" tone="muted">
            Copy this link now. For security it can’t be shown again.
          </Text>
        </Stack>
      ) : null}

      {composing ? (
        <Form
          className="gap-3 rounded-lg border border-border p-3"
          onValues={(values) => {
            const expires = optionalFormText(values, "expires");
            const password = formText(values, "password");
            create.mutate(
              {
                itemId,
                role,
                public: true,
                password: password === "" ? undefined : password,
                expiresAt: expires === undefined ? null : endOfLocalDayIso(expires),
              },
              {
                onSuccess(created) {
                  if (created.url !== null) setIssued({ id: created.id, url: created.url });
                  closeComposer();
                },
              },
            );
          }}
        >
          <Field>
            <Label htmlFor="link-role">Anyone with the link can</Label>
            <ShareRoleSelect id="link-role" value={role} onChange={setRole} />
          </Field>
          <Stack className="gap-3 sm:flex-row">
            <Field className="min-w-0 flex-1">
              <Label htmlFor="link-password">Password (optional)</Label>
              <PasswordInput
                id="link-password"
                name="password"
                autoComplete="new-password"
                minLength={8}
                maxLength={1024}
              />
            </Field>
            <Field className="min-w-0 flex-1">
              <Label htmlFor="link-expires">Expires (optional)</Label>
              <Input id="link-expires" name="expires" type="date" min={today} />
            </Field>
          </Stack>
          <FieldDescription>
            Passwords need at least 8 characters. Neither can be changed later: revoke the link and
            create a new one instead.
          </FieldDescription>
          <MutationFailure error={create.error} />
          <Row className="justify-end gap-2">
            <Button type="button" variant="ghost" onClick={closeComposer}>
              Cancel
            </Button>
            <Button type="submit" pending={create.isPending} pendingLabel="Creating…">
              Create link
            </Button>
          </Row>
        </Form>
      ) : null}

      {shares.length === 0 && !composing && issuedUrl === null ? (
        <Text tone="muted">
          No public links on this item.
          {inheritsAccess ? " Access shared on a parent folder still applies here." : null}
        </Text>
      ) : null}

      {shares.map((share) => (
        <LinkRow
          key={share.id}
          share={share}
          revoking={revoke.isPending && revoke.variables.id === share.id}
          onRevoke={() => setConfirmingRevokeId(share.id)}
        />
      ))}
      <MutationFailure error={revoke.error} />
      <RevokeLinkDialog
        open={confirmingRevokeId !== null}
        linkName={
          confirmingRevoke === undefined
            ? `link to “${itemName}”`
            : `${SHARE_ROLE_LABELS[confirmingRevoke.role]} link to “${itemName}”`
        }
        pending={revoke.isPending}
        onOpenChange={(next) => {
          if (!next) setConfirmingRevokeId(null);
        }}
        onConfirm={revokeConfirmed}
      />
    </Stack>
  );
}

function LinkRow({
  share,
  revoking,
  onRevoke,
}: {
  share: Share;
  revoking: boolean;
  onRevoke: () => void;
}) {
  // Read once when the row appears; the server decides expiry, this only labels it.
  const [renderedAt] = useState(() => Date.now());
  const expired = share.expiresAt !== null && Date.parse(share.expiresAt) <= renderedAt;

  return (
    <Row className="min-h-9 flex-wrap justify-between gap-x-2 gap-y-1">
      <Row className="min-w-0 flex-wrap gap-1.5">
        <InlineText>{SHARE_ROLE_LABELS[share.role]} link</InlineText>
        {share.passwordProtected ? <Tag>Password</Tag> : null}
        {share.expiresAt !== null && !expired ? (
          <Tag>Expires {formatDate(share.expiresAt)}</Tag>
        ) : null}
        {expired ? <Tag>Expired</Tag> : null}
      </Row>
      <Button
        size="sm"
        variant="destructive-outline"
        pending={revoking}
        pendingLabel="Revoking…"
        onClick={onRevoke}
      >
        Revoke
      </Button>
    </Row>
  );
}
