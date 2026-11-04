import type { ShareRole } from "@hyori-cloud/client-sdk";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@hyori-cloud/ui/components/select";
import {
  SHARE_ROLE_DESCRIPTIONS,
  SHARE_ROLE_LABELS,
  SHARE_ROLES,
} from "#features/sharing/share-roles.ts";

export function ShareRoleSelect({
  id,
  label,
  value,
  onChange,
}: {
  id?: string;
  label?: string;
  value: ShareRole;
  onChange: (role: ShareRole) => void;
}) {
  return (
    <Select
      items={SHARE_ROLE_LABELS}
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next);
      }}
    >
      <SelectTrigger id={id} aria-label={label} className="w-full sm:w-32" />
      <SelectContent>
        {SHARE_ROLES.map((role) => (
          <SelectItem key={role} value={role} description={SHARE_ROLE_DESCRIPTIONS[role]}>
            {SHARE_ROLE_LABELS[role]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
