import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { Field, FieldDescription, Form } from "@hyori-cloud/ui/components/field";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { AccountFields } from "#features/auth/react/account-fields.tsx";
import { useSetup } from "#features/auth/react/use-setup.ts";
import { formText } from "#features/shared/form-values.ts";
import { useHydrated } from "#features/shared/react/use-hydrated.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function SetupScreen() {
  const setup = useSetup();
  const ready = useHydrated();

  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>Set up this server</Heading>
        <Text tone="muted">
          The first account becomes the administrator. This can only happen once.
        </Text>
      </FocusLayoutHeader>
      <Form
        onValues={(values) =>
          setup.mutate({
            setupToken: formText(values, "setupToken"),
            name: formText(values, "name"),
            email: formText(values, "email"),
            password: formText(values, "password"),
          })
        }
      >
        <Field>
          <Label htmlFor="setup-token">Setup token</Label>
          <PasswordInput
            id="setup-token"
            name="setupToken"
            autoComplete="off"
            required
            maxLength={256}
            aria-describedby="setup-token-hint"
          />
          <FieldDescription id="setup-token-hint">
            Proves you control this server. It’s in the server’s configuration.
          </FieldDescription>
        </Field>
        <AccountFields idPrefix="setup" />
        <MutationFailure error={setup.error} />
        <Button
          type="submit"
          size="lg"
          disabled={!ready}
          pending={setup.isPending}
          pendingLabel="Creating account…"
        >
          Create admin account
        </Button>
      </Form>
    </FocusLayout>
  );
}
