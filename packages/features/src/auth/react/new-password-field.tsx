import { Field, FieldDescription, FieldError } from "@hyori-cloud/ui/components/field";
import { Label } from "@hyori-cloud/ui/components/label";
import { PasswordInput } from "@hyori-cloud/ui/components/password-input";
import { NEW_PASSWORD_HINT } from "#features/auth/password-copy.ts";

/** The length is checked in the form, so its message is ours rather than the browser's tooltip. */
export function NewPasswordField({
  id,
  problem,
  onEdit,
  autoFocus,
}: {
  id: string;
  problem: string | null;
  onEdit: () => void;
  autoFocus?: boolean;
}) {
  return (
    <Field>
      <Label htmlFor={id}>New password</Label>
      <PasswordInput
        id={id}
        name="newPassword"
        autoComplete="new-password"
        required
        maxLength={1024}
        autoFocus={autoFocus}
        aria-invalid={problem === null ? undefined : true}
        aria-describedby={`${id}-hint`}
        onInput={onEdit}
      />
      {problem === null ? (
        <FieldDescription id={`${id}-hint`}>{NEW_PASSWORD_HINT}</FieldDescription>
      ) : (
        <FieldError id={`${id}-hint`}>{problem}</FieldError>
      )}
    </Field>
  );
}
