import type { ShareRole } from "@hyori-cloud/client-sdk";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@hyori-cloud/ui/components/select";
import { cn } from "@hyori-cloud/ui/lib/utils";
import {
  SHARE_ROLE_DESCRIPTIONS,
  SHARE_ROLE_LABELS,
  SHARE_ROLES,
} from "#features/sharing/share-roles.ts";

export function ShareRoleSelect({
  id,
  label,
  className,
  value,
  onChange,
}: {
  id?: string;
  label?: string;
  /** Narrow rows want a fixed width rather than the stacked-form default. */
  className?: string;
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
      <SelectTrigger id={id} aria-label={label} className={cn("w-full sm:w-32", className)} />
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
