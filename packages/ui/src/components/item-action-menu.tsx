"use client";

import { buttonVariants } from "@hyori-cloud/ui/components/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useItemTabIndex } from "@hyori-cloud/ui/components/item-collection";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { EllipsisIcon } from "lucide-react";
import * as React from "react";

/** The per-row overflow menu. Its trigger joins the collection's roving tab stop. */
function ItemActionMenu({ label, children }: { label: string; children: React.ReactNode }) {
  const tabIndex = useItemTabIndex();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        data-item-action
        tabIndex={tabIndex}
        aria-label={label}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      >
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">{children}</DropdownMenuContent>
    </DropdownMenu>
  );
}

export { ItemActionMenu };
