import type { FileEntry, ShareRole, UserIdentity } from "@hyori-cloud/client-sdk";
import type { KeyboardEvent } from "@hyori-cloud/lib/react";
import { useMemo, useRef, useState } from "@hyori-cloud/lib/react";
import { Avatar, AvatarFallback } from "@hyori-cloud/ui/components/avatar";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxStatus,
  createComboboxItems,
} from "@hyori-cloud/ui/components/combobox";
import { Field } from "@hyori-cloud/ui/components/field";
import { Label } from "@hyori-cloud/ui/components/label";
import { InlineText, Stack } from "@hyori-cloud/ui/components/text";
import { useDisposeOnUnmount } from "@hyori-cloud/ui/hooks/use-dispose-on-unmount";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { FailedShareAction } from "#features/sharing/react/share-action-notice.tsx";
import { ShareActionNotice } from "#features/sharing/react/share-action-notice.tsx";
import { ShareRoleSelect } from "#features/sharing/react/share-role-select.tsx";
import {
  pendingShareId,
  upsertShare,
  useSharesCache,
  withoutShare,
} from "#features/sharing/react/shares-cache.ts";
import { useCreateShare, useUserSearch } from "#features/sharing/react/use-shares.ts";

/**
 * The server matches people by name or email. Keystrokes commit here after a short pause so a
 * phrase doesn't spend its rate limit one letter at a time.
 */
const SEARCH_COMMIT_MS = 180;

/** Stable empty result list, so the memoized collection keeps one identity while nothing loads. */
const EMPTY_RESULTS: readonly UserIdentity[] = [];

export function RecipientPicker({
  entry,
  excludedIds,
}: {
  entry: FileEntry;
  /** The owner and everyone already granted access, who the server shouldn't suggest again. */
  excludedIds: ReadonlySet<string>;
}) {
  const cache = useSharesCache(entry.id);
  const create = useCreateShare();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const [open, setOpen] = useState(false);
  // Whether a suggestion is highlighted: Enter then picks it, instead of sharing the typed text.
  const [hasHighlight, setHasHighlight] = useState(false);
  const [failure, setFailure] = useState<FailedShareAction | null>(null);
  const commitSearch = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const trimmed = draft.trim();
  const results = useUserSearch(search, search.length > 0);

  // Every keystroke restarts the commit; whatever was already searched for stays on screen below.
  // Base UI also clears the input when the popup closes with nothing selected (`input-clear`);
  // the draft ignores that, so a failed or unfinished add keeps what was typed.
  function onInputValueChange(value: string, details: { reason: string }) {
    if (details.reason !== "input-change") return;

    setDraft(value);
    clearTimeout(commitSearch.current);
    commitSearch.current = setTimeout(() => setSearch(value.trim()), SEARCH_COMMIT_MS);
  }

  useDisposeOnUnmount(() => clearTimeout(commitSearch.current));

  const people = results.data?.items ?? EMPTY_RESULTS;

  // The people the picker may offer: the owner and anyone already granted are filtered out. Both
  // lists keep one identity per result set, so the collection's memo stays stable (see Base UI).
  const visible = useMemo(
    () => people.filter((user) => !excludedIds.has(user.id)),
    [people, excludedIds],
  );

  // The collection lets selection events carry the account id while the list renders the person;
  // identities stay stable, so Base UI's highlight tracking never thrashes.
  const suggestions = useMemo(
    () =>
      createComboboxItems(visible, { getValue: (user) => user.id, getLabel: (user) => user.name }),
    [visible],
  );

  function grant(recipient: UserIdentity | null, recipientId: string) {
    const pendingId = pendingShareId(recipientId);
    const name = recipient?.name ?? recipientId;

    if (recipientId === "" || create.isPending) return;
    setFailure(null);
    // The row appears beside this field while the request runs; the central invalidation on
    // success replaces it with the server's share.
    void cache.snapshot().then(() =>
      cache.amend((page) =>
        upsertShare(page, {
          id: pendingId,
          itemId: entry.id,
          role,
          public: false,
          recipientId,
          recipient,
          expiresAt: null,
          passwordProtected: false,
          revokedAt: null,
          url: null,
        }),
      ),
    );
    create.mutate(
      { itemId: entry.id, role, public: false, recipientId },
      {
        onSuccess(created) {
          cache.amend((page) => upsertShare(withoutShare(page, pendingId), created));
          clearTimeout(commitSearch.current);
          setDraft("");
          setSearch("");
          setHasHighlight(false);
          setOpen(false);
          // The next person starts from the least access, and the field is ready for them.
          setRole("viewer");
        },
        onError(error) {
          cache.amend((page) => withoutShare(page, pendingId));
          // A failed add keeps the typed text to correct, not to retype.
          setFailure({
            title: `Couldn’t share with ${name}`,
            error,
            retry: () => grant(recipient, recipientId),
          });
        },
      },
    );
  }

  // Enter with a suggestion highlighted selects it; Enter on anything else shares by what was typed,
  // which is how an account ID still finds its person when no one is suggested.
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || hasHighlight) return;

    const recipientId = draft.trim();

    if (recipientId === "") return;

    event.preventDefault();
    grant(null, recipientId);
  }

  const settled = trimmed !== "" && search === trimmed && results.fetchStatus !== "fetching";

  const fetching = results.fetchStatus === "fetching";

  let empty: string;

  if (results.error !== null) {
    const copy = describeCloudError(results.error);
    empty = copy.detail === undefined ? copy.title : `${copy.title}. ${copy.detail}`;
  } else if (trimmed === "") {
    empty = "Search by name or email.";
  } else if (!settled) {
    empty = "Searching…";
  } else if (people.length > 0 && visible.length === 0) {
    empty = "Everyone matching already has access.";
  } else {
    empty = `No one matches “${trimmed}”`;
  }

  let status: string;

  if (fetching || (trimmed !== "" && search !== trimmed)) status = "Searching";
  else if (visible.length > 0)
    status = `${visible.length} ${visible.length === 1 ? "result" : "results"}`;
  else status = "No results";

  return (
    <Stack className="gap-2">
      <Field>
        <Label htmlFor="share-recipient" className="sr-only">
          Add people by name or email
        </Label>
        <Stack className="gap-2 sm:flex-row">
          <div className="min-w-0 flex-1">
            <Combobox<string, UserIdentity>
              inputValue={draft}
              onInputValueChange={onInputValueChange}
              // The grant is the selection: the combobox holds none, so a later popup close can
              // never re-sync a stale pick into the input the user is typing in.
              value={null}
              open={open}
              onOpenChange={setOpen}
              autoHighlight
              items={suggestions}
              filteredItems={visible}
              onItemHighlighted={(id) => setHasHighlight(id !== undefined)}
              onValueChange={(id) => {
                if (id === null) return;
                grant(visible.find((user) => user.id === id) ?? null, id);
              }}
            >
              <ComboboxInput
                id="share-recipient"
                placeholder="Name or email"
                autoComplete="off"
                spellCheck={false}
                onKeyDown={onKeyDown}
              />
              <ComboboxContent>
                {visible.map((user) => (
                  <ComboboxItem key={user.id} value={user.id}>
                    <Avatar className="size-7">
                      <AvatarFallback name={user.name} />
                    </Avatar>
                    <Stack className="min-w-0 gap-0">
                      <InlineText className="truncate font-medium">{user.name}</InlineText>
                      <InlineText className="truncate text-muted-foreground">
                        {user.email}
                      </InlineText>
                    </Stack>
                  </ComboboxItem>
                ))}
                <ComboboxEmpty>{empty}</ComboboxEmpty>
                {fetching && visible.length > 0 ? (
                  <InlineText className="px-2 py-1.5 text-muted-foreground">Searching…</InlineText>
                ) : null}
                <ComboboxStatus>{status}</ComboboxStatus>
              </ComboboxContent>
            </Combobox>
          </div>
          <ShareRoleSelect label="Role for this person" value={role} onChange={setRole} />
          <Button
            type="button"
            variant="outline"
            disabled={trimmed === ""}
            pending={create.isPending}
            pendingLabel="Adding…"
            onClick={() => grant(null, trimmed)}
          >
            Add
          </Button>
        </Stack>
      </Field>
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
