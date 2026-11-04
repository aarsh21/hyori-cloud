"use client";

import {
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useAppearance } from "@hyori-cloud/ui/theme";
import { MonitorIcon, MoonIcon, SunIcon } from "lucide-react";

export function AppearanceMenuItems() {
  const { preference, setPreference } = useAppearance();

  return (
    <DropdownMenuGroup>
      <DropdownMenuLabel>Appearance</DropdownMenuLabel>
      <DropdownMenuRadioGroup
        value={preference ?? ""}
        aria-label="Appearance"
        onValueChange={(value) => {
          if (value === "light" || value === "dark" || value === "system") setPreference(value);
        }}
      >
        <DropdownMenuRadioItem
          value="light"
          disabled={preference === undefined}
          closeOnClick
          className="coarse:min-h-10"
        >
          <SunIcon aria-hidden />
          Light
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="dark"
          disabled={preference === undefined}
          closeOnClick
          className="coarse:min-h-10"
        >
          <MoonIcon aria-hidden />
          Dark
        </DropdownMenuRadioItem>
        <DropdownMenuRadioItem
          value="system"
          disabled={preference === undefined}
          closeOnClick
          className="coarse:min-h-10"
        >
          <MonitorIcon aria-hidden />
          System
        </DropdownMenuRadioItem>
      </DropdownMenuRadioGroup>
    </DropdownMenuGroup>
  );
}
