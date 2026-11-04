import { AppearanceMenu } from "@hyori-cloud/ui/components/appearance-menu";
import { Button } from "@hyori-cloud/ui/components/button";
import { Field, Form } from "@hyori-cloud/ui/components/field";
import { FocusLayout, FocusLayoutHeader } from "@hyori-cloud/ui/components/focus-layout";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { Heading, Text } from "@hyori-cloud/ui/components/text";
import { Wordmark } from "@hyori-cloud/ui/components/wordmark";
import { useLogin } from "#features/auth/react/use-login.ts";
import { formText } from "#features/shared/form-values.ts";
import { MutationFailure } from "#features/shared/react/mutation-failure.tsx";

export function LoginScreen() {
  const login = useLogin();

  return (
    <FocusLayout footer={<AppearanceMenu />}>
      <Wordmark />
      <FocusLayoutHeader>
        <Heading>Sign in</Heading>
        <Text tone="muted">Accounts on this server are created by its admin.</Text>
      </FocusLayoutHeader>
      <Form
        onValues={(values) =>
          login.mutate({ email: formText(values, "email"), password: formText(values, "password") })
        }
      >
        <Field>
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
          />
        </Field>
        <Field>
          <Label htmlFor="login-password">Password</Label>
          <PasswordInput
            id="login-password"
            name="password"
            autoComplete="current-password"
            required
          />
        </Field>
        <MutationFailure error={login.error} />
        <Button type="submit" size="lg" pending={login.isPending} pendingLabel="Signing in…">
          Sign in
        </Button>
      </Form>
    </FocusLayout>
  );
}
