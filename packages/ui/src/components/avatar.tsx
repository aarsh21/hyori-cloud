"use client";

import { Avatar as AvatarPrimitive } from "@base-ui/react/avatar";
import { cn } from "@hyori-cloud/ui/lib/utils";

/**
 * One or two uppercase letters from a person's name, on a neutral disc. Accounts here carry no
 * profile images, so the fallback is the avatar; the parts stay composable for the day they do.
 */
function Avatar({ className, ...props }: AvatarPrimitive.Root.Props) {
  return (
    <AvatarPrimitive.Root
      data-slot="avatar"
      className={cn(
        "relative grid size-6 shrink-0 place-items-center overflow-hidden rounded-full bg-foreground/8 text-[11px] font-medium text-foreground select-none",
        className,
      )}
      {...props}
    />
  );
}

/** From "Ada Lovelace" to "AL", from "ada@example.com" to "A", from anything else to "?". */
export function initialsOf(name: string, fallback = "?"): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0);

  if (parts.length === 0) return fallback;

  if (parts.length === 1) return parts[0]!.charAt(0).toUpperCase();

  return `${parts[0]!.charAt(0)}${parts.at(-1)!.charAt(0)}`.toUpperCase();
}

function AvatarFallback({
  name,
  className,
  ...props
}: AvatarPrimitive.Fallback.Props & { name: string }) {
  return (
    <AvatarPrimitive.Fallback
      data-slot="avatar-fallback"
      aria-hidden
      className={cn("tabular-nums", className)}
      {...props}
    >
      {initialsOf(name)}
    </AvatarPrimitive.Fallback>
  );
}

export { Avatar, AvatarFallback };
