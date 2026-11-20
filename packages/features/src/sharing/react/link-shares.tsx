import type { Share, ShareRole } from "@hyori-cloud/client-sdk";
import { Check, ChevronDown, Link2 } from "@hyori-cloud/lib/icons";
import { useRef, useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { LinkField } from "@hyori-cloud/ui/components/copy-button";
import { DatePicker } from "@hyori-cloud/ui/components/date-picker";
import { Field, FieldDescription } from "@hyori-cloud/ui/components/field";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@hyori-cloud/ui/components/select";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText, Row, SectionHeading, Stack, Text } from "@hyori-cloud/ui/components/text";
import { useDisposeOnUnmount } from "@hyori-cloud/ui/hooks/use-dispose-on-unmount";
import { copyText } from "@hyori-cloud/ui/lib/browser";
import { endOfLocalDayIso, formatDate, localDateInputValue } from "#features/shared/format.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { RevokeLinkDialog } from "#features/sharing/react/revoke-link-dialog.tsx";
import { ShareRoleSelect } from "#features/sharing/react/share-role-select.tsx";
import { useCreateShare, useRevokeShare } from "#features/sharing/react/use-shares.ts";
import { SHARE_ROLE_LABELS } from "#features/sharing/share-roles.ts";

const COPIED_MS = 1500;

const EXPIRY_CHOICES = ["none", "day", "week", "month", "custom"] as const;

type ExpiryChoice = (typeof EXPIRY_CHOICES)[number];

const EXPIRY_LABELS: Record<ExpiryChoice, string> = {
  none: "No end date",
  day: "1 day",
  week: "7 days",
  month: "30 days",
  custom: "Custom…",
};

const EXPIRY_DAYS: Record<Exclude<ExpiryChoice, "none" | "custom">, number> = {
  day: 1,
  week: 7,
  month: 30,
};

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
  const [role, setRole] = useState<ShareRole>("viewer");
  const [password, setPassword] = useState("");
  const [expiry, setExpiry] = useState<ExpiryChoice>("none");
  const [customDay, setCustomDay] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [confirmingRevokeId, setConfirmingRevokeId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const revertCopied = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const create = useCreateShare();
  const revoke = useRevokeShare();
  const confirmingRevoke = shares.find((share) => share.id === confirmingRevokeId);
  // A date picker's minimum, read once: an already-past expiry would make a link that never works.
  const [today] = useState(() => localDateInputValue(new Date()));

  useDisposeOnUnmount(() => clearTimeout(revertCopied.current));

  // The server keeps only a hash of the token, so the URL exists solely in this response. This is a
  // real copy because a mutation forgets its result as soon as another starts: a failed second link
  // or list refresh mustn't lose the only chance to copy this one. It ends with the dialog's popup.
  const [issued, setIssued] = useState<{ readonly id: string; readonly url: string } | null>(null);
  const issuedUrl = issued?.url ?? null;

  // One click shares with the least access. Everything the settings offer applies to the next link
  // created, then returns here, so the next click is plain again.
  function resetSettings() {
    setRole("viewer");
    setPassword("");
    setExpiry("none");
    setCustomDay(null);
  }

  function expiryIso(): string | null {
    if (expiry === "none") return null;

    if (expiry === "custom") return customDay === null ? null : endOfLocalDayIso(customDay);

    const date = new Date();

    date.setDate(date.getDate() + EXPIRY_DAYS[expiry]);

    return endOfLocalDayIso(localDateInputValue(date));
  }

  function createLink() {
    if (expiry === "custom" && customDay === null) return;

    create.mutate(
      {
        itemId,
        role,
        public: true,
        password: password === "" ? undefined : password,
        expiresAt: expiryIso(),
      },
      {
        onSuccess(created) {
          setSettingsOpen(false);
          resetSettings();

          if (created.url === null) return;

          setIssued({ id: created.id, url: created.url });
          copyText(new URL(created.url, document.baseURI).href)
            .then(() => {
              setCopied(true);
              clearTimeout(revertCopied.current);
              revertCopied.current = setTimeout(() => setCopied(false), COPIED_MS);
            })
            .catch(() => {
              // The issued link below stays on screen to copy by hand.
            });
        },
      },
    );
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

  const needsCustomDay = expiry === "custom" && customDay === null;

  return (
    <Stack className="gap-2.5">
      <Row className="justify-between gap-2">
        <SectionHeading>Public links</SectionHeading>
        <Row className="gap-2">
          {settingsOpen ? null : (
            <Button
              pending={create.isPending}
              pendingLabel="Creating…"
              onClick={() => createLink()}
            >
              <Link2 aria-hidden />
              {copied ? (
                <span aria-live="polite" className="inline-flex items-center gap-1.5">
                  <Check aria-hidden className="size-3.5" />
                  Copied
                </span>
              ) : (
                "Copy link"
              )}
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen(!settingsOpen)}
          >
            Link settings
            <ChevronDown
              aria-hidden
              className={`size-3.5 transition-transform duration-150 ${settingsOpen ? "rotate-180" : ""}`}
            />
          </Button>
        </Row>
      </Row>
      <MutationFailure error={create.error} />

      {issuedUrl !== null ? (
        <Stack className="gap-1.5">
          <LinkField value={issuedUrl} label="Public link" />
          <Text size="xs" tone="muted">
            Copy this link now. For security it can’t be shown again.
          </Text>
        </Stack>
      ) : null}

      {settingsOpen ? (
        <Stack className="gap-3 rounded-lg border border-border p-3">
          <Field>
            <Label htmlFor="link-role">Anyone with the link can</Label>
            <ShareRoleSelect id="link-role" value={role} onChange={setRole} />
          </Field>
          <Field>
            <Label htmlFor="link-password">Password (optional)</Label>
            <PasswordInput
              id="link-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
              minLength={8}
              maxLength={1024}
            />
          </Field>
          <Field>
            <Label htmlFor="link-expiry">Expires</Label>
            <Row className="gap-2">
              <Select
                items={EXPIRY_LABELS}
                value={expiry}
                onValueChange={(next) => {
                  if (next !== null) setExpiry(next);
                }}
              >
                <SelectTrigger id="link-expiry" className="w-full sm:w-36" />
                <SelectContent>
                  {EXPIRY_CHOICES.map((choice) => (
                    <SelectItem key={choice} value={choice}>
                      {EXPIRY_LABELS[choice]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {expiry === "custom" ? (
                <DatePicker
                  className="min-w-0 flex-1"
                  label="Expiry date"
                  value={customDay}
                  min={today}
                  onValueChange={setCustomDay}
                />
              ) : null}
            </Row>
          </Field>
          <FieldDescription>
            A link’s role, password, and expiry are set when it’s created and can’t be changed
            later. Create a new link instead. Passwords need at least 8 characters.
          </FieldDescription>
          <Row className="justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setSettingsOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={needsCustomDay}
              pending={create.isPending}
              pendingLabel="Creating…"
              onClick={() => createLink()}
            >
              Create new link
            </Button>
          </Row>
        </Stack>
      ) : null}

      {shares.length === 0 && issuedUrl === null ? (
        <Text tone="muted">
          No public links yet.
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
        <InlineText>Anyone with the link · {SHARE_ROLE_LABELS[share.role]}</InlineText>
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
