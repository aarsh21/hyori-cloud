import { useRef, useState } from "@hyori-cloud/lib/react";
import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import { formText } from "#features/shared/form-values.ts";
import { AccessRecoveryProvider } from "#features/shared/react/access-recovery.tsx";
import type { AccessRecoveryPolicy } from "#features/shared/react/access-recovery.tsx";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";
import { PublicEditor } from "#features/sharing/react/public-editor.tsx";
import { PublicSharedItem } from "#features/sharing/react/public-shared-item.tsx";
import { useResolveShare, useUnlockShare } from "#features/sharing/react/use-shares.ts";
import { UploadsProvider } from "#features/uploads/react/uploads-provider.tsx";

/**
 * Resolving a link issues a session grant, so it is an explicit action rather than a side effect
 * of loading the page. That also keeps link previews and scanners from claiming grants.
 *
 * The upload queue sits above every state below. Asking for a password again must not dispose
 * anonymous uploads, whose only copy of each file is the reference this queue holds.
 */
export function PublicShareScreen({
  token,
  folderId,
  editingFileId,
}: {
  token: string;
  folderId: string | null;
  editingFileId: string | null;
}) {
  return (
    <UploadsProvider scope={null}>
      <TooltipProvider>
        <PublicShareAccess token={token} folderId={folderId} editingFileId={editingFileId} />
      </TooltipProvider>
    </UploadsProvider>
  );
}

function PublicShareAccess({
  token,
  folderId,
  editingFileId,
}: {
  token: string;
  folderId: string | null;
  editingFileId: string | null;
}) {
  const resolve = useResolveShare();
  const reopen = useResolveShare();
  const unlock = useUnlockShare();
  const [latestAnswer, setLatestAnswer] = useState(reopen.data);
  const resolved = unlock.data ?? latestAnswer ?? resolve.data;
  // Access isn't back until the password is accepted, so whatever asked to recover waits for that.
  const afterUnlock = useRef<(() => void) | undefined>(undefined);

  // Anonymous visitors have no session to sign back in to: a grant that expired or stopped working
  // comes back only by resolving the link again. A separate mutation keeps the open item, and any
  // upload queue inside it, mounted until that answer arrives.
  const recoveryPolicy: AccessRecoveryPolicy = (error) => {
    if (error.code !== "auth.required" && error.code !== "access.denied") return null;

    const attempt = {
      actionLabel: "Open link again",
      pendingLabel: "Opening…",
      pending: reopen.isPending,
      recover: (onRecovered?: () => void) =>
        reopen.mutate(
          { token },
          {
            onSuccess(answer) {
              setLatestAnswer(answer);
              // An earlier unlock must not outrank the new answer, which may ask for the password.
              unlock.reset();

              if (answer.item === null) afterUnlock.current = onRecovered;
              else onRecovered?.();
            },
          },
        ),
    };

    if (reopen.error === null) {
      return {
        ...attempt,
        title: "Your access through this link has ended",
        detail: "Open the link again to continue.",
      };
    }

    if (reopen.error.code === "access.denied") {
      return {
        ...attempt,
        title: "This link is no longer available",
        detail: "Ask the person who shared it for a new link.",
        actionLabel: "Try again",
      };
    }

    return { ...attempt, ...describeCloudError(reopen.error), actionLabel: "Try again" };
  };

  if (resolved === undefined) {
    return (
      <FocusLayout footer={<AppearanceMenu />}>
        <Wordmark />
        <FocusLayoutHeader>
          <Heading>Someone shared something with you</Heading>
          <Text tone="muted">Open it to see what it is. No account needed.</Text>
        </FocusLayoutHeader>
        <MutationFailure error={resolve.error} />
        <Button
          size="lg"
          pending={resolve.isPending}
          pendingLabel="Opening…"
          onClick={() => resolve.mutate({ token })}
        >
          Open shared item
        </Button>
      </FocusLayout>
    );
  }

  if (resolved.item === null) {
    return (
      <FocusLayout footer={<AppearanceMenu />}>
        <Wordmark />
        <FocusLayoutHeader>
          <Heading>This link needs a password</Heading>
          <Text tone="muted">Ask the person who shared it if you don’t have it.</Text>
        </FocusLayoutHeader>
        <Form
          onValues={(values) =>
            unlock.mutate(
              { token, password: formText(values, "password") },
              {
                onSuccess() {
                  afterUnlock.current?.();
                  afterUnlock.current = undefined;
                },
              },
            )
          }
        >
          <Field>
            <Label htmlFor="link-unlock">Password</Label>
            <PasswordInput id="link-unlock" name="password" autoComplete="off" required autoFocus />
          </Field>
          <MutationFailure error={unlock.error} />
          <Button type="submit" size="lg" pending={unlock.isPending} pendingLabel="Unlocking…">
            Unlock
          </Button>
        </Form>
      </FocusLayout>
    );
  }

  return (
    <AccessRecoveryProvider value={recoveryPolicy}>
      {editingFileId === null ? (
        <PublicSharedItem token={token} folderId={folderId} item={resolved.item} />
      ) : (
        <PublicEditor token={token} fileId={editingFileId} item={resolved.item} />
      )}
    </AccessRecoveryProvider>
  );
}
