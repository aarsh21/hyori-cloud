import type { Share, ShareRole } from "@hyori-cloud/client-sdk";
import { useState } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { Field, FieldDescription, Form } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { PickerList, PickerRow } from "@hyori-cloud/ui/components/picker-list";
import { Tag } from "@hyori-cloud/ui/components/tag";
import { InlineText, Row, SectionHeading, Stack } from "@hyori-cloud/ui/components/text";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { ShareRoleSelect } from "#features/sharing/react/share-role-select.tsx";
import { useCreateShare, useRevokeShare } from "#features/sharing/react/use-shares.ts";
import { SHARE_ROLE_LABELS } from "#features/sharing/share-roles.ts";

/**
 * Sharing is by account ID on purpose: emails here are unverified, so typing one would not prove
 * who receives access. Recipients find their ID in the account menu.
 */
export function AccountShares({ itemId, shares }: { itemId: string; shares: readonly Share[] }) {
  const [recipientId, setRecipientId] = useState("");
  const [role, setRole] = useState<ShareRole>("viewer");
  const create = useCreateShare();
  const revoke = useRevokeShare();

  return (
    <Stack className="gap-2.5">
      <SectionHeading>People</SectionHeading>
      <Form
        className="gap-2"
        onValues={() =>
          create.mutate(
            { itemId, role, public: false, recipientId: recipientId.trim() },
            {
              // Only a success clears this. A failed add keeps a long ID there to correct, and every
              // new person starts from the least access.
              onSuccess() {
                setRecipientId("");
                setRole("viewer");
              },
            },
          )
        }
      >
        <Field>
          <Label htmlFor="share-recipient" className="sr-only">
            Account ID
          </Label>
          <Stack className="gap-2 sm:flex-row">
            <Input
              id="share-recipient"
              name="recipientId"
              value={recipientId}
              onChange={(event) => setRecipientId(event.target.value)}
              placeholder="Account ID"
              required
              autoComplete="off"
              spellCheck={false}
              aria-describedby="share-recipient-hint"
              className="min-w-0 flex-1"
            />
            <ShareRoleSelect label="Role for this person" value={role} onChange={setRole} />
            <Button
              type="submit"
              variant="outline"
              pending={create.isPending}
              pendingLabel="Adding…"
            >
              Add
            </Button>
          </Stack>
          <FieldDescription id="share-recipient-hint">
            They can copy their ID from their account menu.
          </FieldDescription>
        </Field>
        <MutationFailure error={create.error} />
      </Form>
      {shares.length > 0 ? (
        <PickerList aria-label="People with access" className="h-auto max-h-36">
          {shares.map((share) => (
            <PickerRow key={share.id} className="justify-between gap-2 px-2 hover:bg-transparent">
              <InlineText truncate numeric>
                {share.recipientId}
              </InlineText>
              <Row className="shrink-0 gap-2">
                <Tag>{SHARE_ROLE_LABELS[share.role]}</Tag>
                <Button
                  size="sm"
                  variant="ghost"
                  pending={revoke.isPending && revoke.variables.id === share.id}
                  pendingLabel="Removing…"
                  onClick={() => revoke.mutate({ id: share.id })}
                >
                  Remove
                </Button>
              </Row>
            </PickerRow>
          ))}
        </PickerList>
      ) : null}
      <MutationFailure error={revoke.error} />
    </Stack>
  );
}
