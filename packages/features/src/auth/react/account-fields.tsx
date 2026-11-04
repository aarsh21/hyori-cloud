import { Field, FieldDescription } from "@hyori-cloud/ui/components/field";
import { Input } from "@hyori-cloud/ui/components/input";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";

/** Name, email and new password, shared by setup, invite acceptance, and admin account creation. */
export function AccountFields({ idPrefix }: { idPrefix: string }) {
  return (
    <>
      <Field>
        <Label htmlFor={`${idPrefix}-name`}>Name</Label>
        <Input id={`${idPrefix}-name`} name="name" autoComplete="name" required maxLength={255} />
      </Field>
      <Field>
        <Label htmlFor={`${idPrefix}-email`}>Email</Label>
        <Input
          id={`${idPrefix}-email`}
          name="email"
          type="email"
          autoComplete="email"
          required
          maxLength={254}
        />
      </Field>
      <Field>
        <Label htmlFor={`${idPrefix}-password`}>Password</Label>
        <PasswordInput
          id={`${idPrefix}-password`}
          name="password"
          autoComplete="new-password"
          required
          minLength={12}
          maxLength={1024}
          aria-describedby={`${idPrefix}-password-hint`}
        />
        <FieldDescription id={`${idPrefix}-password-hint`}>
          At least 12 characters. A few unrelated words are strong and easy to remember.
        </FieldDescription>
      </Field>
    </>
  );
}
