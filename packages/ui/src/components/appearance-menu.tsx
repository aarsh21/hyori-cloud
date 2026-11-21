"use client";

import { AppearanceMenuItems } from "@hyori-cloud/ui/components/appearance-menu-items";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useAppearance } from "@hyori-cloud/ui/theme";
import { SunMoonIcon } from "lucide-react";
import type { ReactNode } from "react";

export function AppearanceMenu({
  children,
  compact = false,
}: {
  children?: ReactNode;
  /** In a crowded phone page bar the label goes to screen readers and the icon stays. */
  compact?: boolean;
}) {
  const { preference } = useAppearance();
  const label = <span className={compact ? "max-md:sr-only" : undefined}>Appearance</span>;

  // The menu's store can't render on the server, which would drop the whole page out of server
  // rendering. Until hydration there's nothing to choose yet, so the same button stands in for it.
  if (preference === undefined) {
    return (
      <Button variant="ghost">
        <SunMoonIcon aria-hidden />
        {label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" />}>
        <SunMoonIcon aria-hidden />
        {label}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="transition-none">
        <AppearanceMenuItems />
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
