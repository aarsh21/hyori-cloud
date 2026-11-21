"use client";

import { buttonVariants } from "@hyori-cloud/ui/components/button";
import {
  createDropdownMenuHandle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useItemTabIndex } from "@hyori-cloud/ui/components/item-collection";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { EllipsisIcon } from "lucide-react";
import * as React from "react";

const ItemMenuContext = React.createContext<ReturnType<
  typeof createDropdownMenuHandle<React.ReactNode>
> | null>(null);

/** A collection shares one popup; closed rows keep only their native menu trigger. */
function ItemActionMenuScope({
  children,
  onOpenChange,
}: {
  children: React.ReactNode;
  onOpenChange?: (open: boolean) => void;
}) {
  const [handle] = React.useState(createDropdownMenuHandle<React.ReactNode>);

  return (
    <ItemMenuContext value={handle}>
      {children}
      <DropdownMenu handle={handle} onOpenChange={onOpenChange}>
        {({ payload }) => (
          <DropdownMenuContent align="end" className="transition-none">
            {payload}
          </DropdownMenuContent>
        )}
      </DropdownMenu>
    </ItemMenuContext>
  );
}

/** The per-row overflow menu. Its trigger joins the collection's roving tab stop. */
function ItemActionMenu({
  label,
  onOpenChange,
  children,
}: {
  label: string;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const tabIndex = useItemTabIndex();
  const handle = React.useContext(ItemMenuContext);

  const bindTrigger = React.useCallback(
    (trigger: HTMLElement | null) => {
      if (trigger === null || handle === null) return;

      return () => {
        // The popup outlives its row; a removed/virtualized owner must not leave stale actions.
        if (trigger.getAttribute("aria-expanded") === "true") handle.close();
      };
    },
    [handle],
  );

  if (handle !== null && onOpenChange === undefined)
    return (
      <DropdownMenuTrigger
        handle={handle}
        payload={children}
        ref={bindTrigger}
        data-item-action
        tabIndex={tabIndex}
        aria-label={label}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-sm" }))}
      >
        <EllipsisIcon aria-hidden />
      </DropdownMenuTrigger>
    );

  return (
    <DropdownMenu onOpenChange={onOpenChange}>
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

export { ItemActionMenu, ItemActionMenuScope };
