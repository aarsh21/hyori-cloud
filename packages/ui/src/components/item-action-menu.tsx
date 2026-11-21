"use client";

import { buttonVariants } from "@hyori-cloud/ui/components/button";
import { createDrawerHandle, DrawerTrigger } from "@hyori-cloud/ui/components/drawer";
import {
  createDropdownMenuHandle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuSheet,
  DropdownMenuTrigger,
} from "@hyori-cloud/ui/components/dropdown-menu";
import { useItemTabIndex } from "@hyori-cloud/ui/components/item-collection";
import { useCoarsePointer } from "@hyori-cloud/ui/hooks/use-coarse-pointer";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { EllipsisIcon } from "lucide-react";
import * as React from "react";

/** What one row puts in the shared popup: its actions, and the name and heading a sheet shows. */
type ItemMenuPayload = { label: string; heading?: string; actions: React.ReactNode };

type ItemMenuHandles =
  | { sheet: false; handle: ReturnType<typeof createDropdownMenuHandle<ItemMenuPayload>> }
  | {
      sheet: true;
      handle: ReturnType<typeof createDrawerHandle<ItemMenuPayload>>;
      /** Renders a row's actions into the closed sheet as the finger lands, before the tap opens it. */
      prepare: (payload: ItemMenuPayload) => void;
    };

const ItemMenuContext = React.createContext<ItemMenuHandles | null>(null);

/**
 * A collection shares one popup; closed rows keep only their native menu trigger. With `sheet`, the
 * popup is a bottom sheet on touch.
 */
function ItemActionMenuScope({
  children,
  sheet = false,
  onOpenChange,
}: {
  children: React.ReactNode;
  sheet?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [menu] = React.useState(createDropdownMenuHandle<ItemMenuPayload>);
  const [drawer] = React.useState(createDrawerHandle<ItemMenuPayload>);
  const asSheet = useCoarsePointer() && sheet;
  const [prepared, setPrepared] = React.useState<ItemMenuPayload>();

  const handles: ItemMenuHandles = asSheet
    ? { sheet: true, handle: drawer, prepare: setPrepared }
    : { sheet: false, handle: menu };

  function changeOpen(open: boolean) {
    // Once open, the sheet shows what its trigger passed; a stale press must not replace it.
    if (open) setPrepared(undefined);
    onOpenChange?.(open);
  }

  return (
    <ItemMenuContext value={handles}>
      {children}
      {asSheet ? (
        <DropdownMenuSheet handle={drawer} onOpenChange={changeOpen}>
          {({ payload }) => {
            const shown = prepared ?? payload;

            return (
              <DropdownMenuContent title={shown?.label} heading={shown?.heading}>
                {shown?.actions}
              </DropdownMenuContent>
            );
          }}
        </DropdownMenuSheet>
      ) : (
        <DropdownMenu handle={menu} onOpenChange={onOpenChange}>
          {({ payload }) => (
            <DropdownMenuContent align="end" className="transition-none">
              {payload?.actions}
            </DropdownMenuContent>
          )}
        </DropdownMenu>
      )}
    </ItemMenuContext>
  );
}

/** The per-row overflow menu. Its trigger joins the collection's roving tab stop. */
function ItemActionMenu({
  label,
  heading,
  onOpenChange,
  children,
}: {
  label: string;
  /** Shown at the top of the sheet on touch, such as the item's name. */
  heading?: string;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactNode;
}) {
  const tabIndex = useItemTabIndex();
  const scope = React.useContext(ItemMenuContext);
  const handle = scope?.handle;

  const bindTrigger = React.useCallback(
    (trigger: HTMLElement | null) => {
      if (trigger === null || handle === undefined) return;

      return () => {
        // The popup outlives its row; a removed/virtualized owner must not leave stale actions.
        if (trigger.getAttribute("aria-expanded") === "true") handle.close();
      };
    },
    [handle],
  );

  const triggerProps = {
    ref: bindTrigger,
    "data-item-action": true,
    tabIndex,
    "aria-label": label,
    className: cn(buttonVariants({ variant: "ghost", size: "icon-sm" })),
    payload: { label, heading, actions: children },
    children: <EllipsisIcon aria-hidden />,
  };

  if (scope !== null && onOpenChange === undefined)
    return scope.sheet ? (
      <DrawerTrigger
        handle={scope.handle}
        onPointerDown={() => scope.prepare(triggerProps.payload)}
        {...triggerProps}
      />
    ) : (
      <DropdownMenuTrigger handle={scope.handle} {...triggerProps} />
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
