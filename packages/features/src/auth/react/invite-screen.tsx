import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { Form } from "@hyori-cloud/ui/components/field";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { AccountFields } from "#features/auth/react/account-fields.tsx";
import { useAcceptInvite } from "#features/auth/react/use-accept-invite.ts";
import { useNavigateTo } from "#features/cloud/react/cloud-navigation.tsx";
import { formText } from "#features/shared/form-values.ts";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function InviteScreen({ token }: { token: string }) {
  const accept = useAcceptInvite();
  const ready = useHydrated();
  const navigateTo = useNavigateTo();

  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>Create your account</Heading>
        <Text tone="muted">You’ve been invited to this Hyori server.</Text>
      </FocusLayoutHeader>
      <Form
        onValues={(values) =>
          accept.mutate(
            {
              token,
              name: formText(values, "name"),
              email: formText(values, "email"),
              password: formText(values, "password"),
            },
            { onSuccess: () => navigateTo({ section: "files", folderId: null }) },
          )
        }
      >
        <AccountFields idPrefix="invite" />
        <MutationFailure error={accept.error} />
        <Button
          type="submit"
          size="lg"
          disabled={!ready}
          pending={accept.isPending}
          pendingLabel="Creating account…"
        >
          Create account
        </Button>
      </Form>
    </FocusLayout>
  );
}
