import { useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { Form } from "@hyori-cloud/ui/components/field";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import {
  describeResetPasswordError,
  INVALID_RESET_LINK,
  isUnusableResetLink,
  newPasswordProblem,
} from "#features/auth/password-copy.ts";
import { NewPasswordField } from "#features/auth/react/new-password-field.tsx";
import { useResetPassword } from "#features/auth/react/use-password.ts";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { formText } from "#features/shared/form-values.ts";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

/**
 * Redeeming the link ends every session of the account and signs no one in, so the page ends at
 * sign-in. A link that was used, replaced or expired can't be told apart, and doesn't need to be.
 */
export function PasswordResetScreen({ token }: { token: string }) {
  const reset = useResetPassword();
  const ready = useHydrated();
  const navigateTo = useNavigateTo();
  const [problem, setProblem] = useState<string | null>(null);
  const signIn = () => navigateTo({ section: "files", folderId: null });

  if (reset.isSuccess) {
    return (
      <ResetLayout
        title="Password changed"
        description="You’re signed out on every device. Sign in with your new password."
      >
        {/* The form that held focus is gone; this is where the person goes next. */}
        <Button size="lg" onClick={signIn} autoFocus>
          Sign in
        </Button>
      </ResetLayout>
    );
  }

  if (reset.error !== null && isUnusableResetLink(reset.error)) {
    return (
      <ResetLayout title="This link can’t be used" description={INVALID_RESET_LINK}>
        <Button size="lg" variant="outline" onClick={signIn} autoFocus>
          Go to sign-in
        </Button>
      </ResetLayout>
    );
  }

  return (
    <ResetLayout
      title="Choose a new password"
      description="Saving it signs you out on every device. Then you sign in with the new password."
    >
      <Form
        onValues={(values) => {
          const newPassword = formText(values, "newPassword");
          const tooShort = newPasswordProblem(newPassword);

          setProblem(tooShort);

          // Only the current problem shows: an earlier failure no longer describes this attempt.
          if (tooShort === null) reset.mutate({ token, newPassword });
          else reset.reset();
        }}
      >
        <NewPasswordField
          id="reset-password-new"
          problem={problem}
          onEdit={() => setProblem(null)}
          autoFocus
        />
        <MutationFailure error={reset.error} describe={describeResetPasswordError} />
        <Button
          type="submit"
          size="lg"
          disabled={!ready}
          pending={reset.isPending}
          pendingLabel="Saving…"
        >
          Save password
        </Button>
      </Form>
    </ResetLayout>
  );
}

function ResetLayout({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>{title}</Heading>
        <Text tone="muted">{description}</Text>
      </FocusLayoutHeader>
      {children}
    </FocusLayout>
  );
}
