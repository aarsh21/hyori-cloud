"use client";

import { AppearanceMenuItems } from "@hyori-cloud/ui/components/appearance-menu-items";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { SunMoonIcon } from "lucide-react";

export function AppearanceMenu() {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" />}>
        <SunMoonIcon aria-hidden />
        Appearance
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="data-open:animate-none data-closed:animate-none">
        <AppearanceMenuItems />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
