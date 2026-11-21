"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerTitle,
  DrawerTrigger,
} from "@hyori-cloud/ui/components/drawer";
import type { DrawerChangeDetails, DrawerHandle } from "@hyori-cloud/ui/components/drawer";
import { useCoarsePointer } from "@hyori-cloud/ui/hooks/use-coarse-pointer";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { ChevronRightIcon, CheckIcon } from "lucide-react";
import * as React from "react";

/**
 * Set inside a menu that renders as a bottom sheet. `instant` is true when a keyboard opened it,
 * which skips the sheet's motion as `data-instant` does for menus.
 */
const SheetContext = React.createContext<{ instant: boolean; returnFocus: () => void } | null>(
  null,
);

/** Menus that opt in with `sheet` open as a bottom sheet on touch; pointers keep the dropdown. */
function DropdownMenu<Payload>({
  sheet = false,
  ...props
}: Omit<MenuPrimitive.Root.Props<Payload>, "onOpenChange"> & {
  sheet?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const coarse = useCoarsePointer();

  if (sheet && coarse)
    return (
      <DropdownMenuSheet onOpenChange={props.onOpenChange}>{props.children}</DropdownMenuSheet>
    );

  return <MenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

/**
 * The sheet form of a menu. A detached trigger opens it through `handle`, as `DropdownMenu` does;
 * its items close it the way menu items close a menu.
 */
function DropdownMenuSheet<Payload>({
  handle,
  onOpenChange,
  children,
}: Pick<DrawerHandleProps<Payload>, "handle" | "children"> & {
  onOpenChange?: (open: boolean) => void;
}) {
  const [instant, setInstant] = React.useState(false);
  const trigger = React.useRef<HTMLElement | null>(null);

  function changeOpen(open: boolean, details: DrawerChangeDetails) {
    setInstant(fromKeyboard(details.event));

    if (open && details.trigger instanceof HTMLElement) trigger.current = details.trigger;
    onOpenChange?.(open);
  }

  // An item's action may open a dialog, which returns focus to whatever had it. A menu has already
  // handed focus back to its trigger by then; the sheet does the same before the action runs.
  function returnFocus() {
    trigger.current?.focus({ preventScroll: true });
  }

  return (
    <SheetContext value={{ instant, returnFocus }}>
      <Drawer handle={handle} onOpenChange={changeOpen}>
        {children}
      </Drawer>
    </SheetContext>
  );
}

type DrawerHandleProps<Payload> = React.ComponentProps<typeof Drawer<Payload>> & {
  handle?: DrawerHandle<Payload>;
};

/** Escape, or Enter and Space on a button, which the browser reports as a click with no presses. */
function fromKeyboard(event: Event) {
  return event instanceof KeyboardEvent || (event instanceof MouseEvent && event.detail === 0);
}

function DropdownMenuPortal({ ...props }: MenuPrimitive.Portal.Props) {
  return <MenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger<Payload>({
  render,
  ...props
}: Omit<MenuPrimitive.Trigger.Props<Payload>, "render"> & { render?: React.ReactElement }) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <DrawerTrigger data-slot="dropdown-menu-trigger" render={render}>
        {props.children}
      </DrawerTrigger>
    );

  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" render={render} {...props} />;
}

function DropdownMenuContent({
  align = "start",
  alignOffset = 0,
  side = "bottom",
  sideOffset = 4,
  title,
  heading,
  className,
  children,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "alignOffset" | "side" | "sideOffset"> & {
    /** The sheet's accessible name; menus take theirs from the trigger. */
    title?: string;
    /** A visible line at the top of the sheet, such as the item the actions apply to. */
    heading?: React.ReactNode;
  }) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <DrawerContent instant={sheet.instant}>
        <DrawerTitle className="sr-only">{title}</DrawerTitle>
        {heading === undefined ? null : (
          <div
            aria-hidden
            className="mx-3 truncate border-b border-border px-3 pt-2 pb-3 text-[14px] font-medium"
          >
            {heading}
          </div>
        )}
        <div data-slot="dropdown-menu-sheet-items" className="flex flex-col p-1.5">
          {children}
        </div>
      </DrawerContent>
    );

  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        className="isolate z-50 outline-none"
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
      >
        {/* Pointer opens grow from the trigger; Base UI marks keyboard opens `data-instant`, which skip motion. */}
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "cn-menu-target cn-menu-translucent z-50 max-h-(--available-height) w-auto min-w-44 p-1 origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-lg bg-popover text-popover-foreground shadow-(--shadow-popover) ring-1 ring-foreground/8 transition-[opacity,scale] duration-150 ease-(--ease-out) outline-none data-starting-style:scale-[0.96] data-starting-style:opacity-0 data-ending-style:scale-[0.96] data-ending-style:opacity-0 data-ending-style:duration-100 data-instant:transition-none",
            className,
          )}
          {...props}
        >
          {children}
        </MenuPrimitive.Popup>
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuGroup({
  className,
  ...props
}: Omit<MenuPrimitive.Group.Props, "className"> & { className?: string }) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <div role="group" data-slot="dropdown-menu-group" className={className}>
        {props.children}
      </div>
    );

  return <MenuPrimitive.Group data-slot="dropdown-menu-group" className={className} {...props} />;
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: Omit<MenuPrimitive.GroupLabel.Props, "className"> & {
  inset?: boolean;
  className?: string;
}) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <div
        data-slot="dropdown-menu-label"
        className={cn("px-3 pt-2 pb-1 text-[13px] text-muted-foreground", className)}
      >
        {props.children}
      </div>
    );

  return (
    <MenuPrimitive.GroupLabel
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn("px-2 py-1.5 text-[13px] text-muted-foreground data-inset:pl-7", className)}
      {...props}
    />
  );
}

/** Sheet rows: 44px, 14px text, a fill on press and on keyboard focus. */
const SHEET_ITEM =
  "flex min-h-11 w-full cursor-default items-center gap-3 rounded-md px-3 text-left text-[14px] outline-none select-none active:bg-accent focus-visible:bg-accent disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg]:text-muted-foreground";

type ItemHandlers = {
  onClick?: () => void;
  onPointerDown?: () => void;
  onPointerEnter?: () => void;
};

function DropdownMenuItem({
  className,
  inset,
  variant = "default",
  onClick,
  onPointerDown,
  onPointerEnter,
  ...props
}: Omit<MenuPrimitive.Item.Props, keyof ItemHandlers | "className"> &
  ItemHandlers & {
    className?: string;
    inset?: boolean;
    variant?: "default" | "destructive";
  }) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <DrawerClose
        data-slot="dropdown-menu-item"
        data-variant={variant}
        disabled={props.disabled}
        onClick={() => {
          sheet.returnFocus();
          onClick?.();
        }}
        onPointerDown={onPointerDown}
        onPointerEnter={onPointerEnter}
        className={cn(
          SHEET_ITEM,
          "data-[variant=destructive]:text-destructive data-[variant=destructive]:[&_svg]:text-destructive",
          className,
        )}
      >
        {props.children}
      </DrawerClose>
    );

  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      onClick={onClick}
      onPointerDown={onPointerDown}
      onPointerEnter={onPointerEnter}
      className={cn(
        "group/dropdown-menu-item relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-hidden select-none coarse:min-h-11 focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive dark:data-[variant=destructive]:focus:bg-destructive/20 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 data-[variant=destructive]:*:[svg]:text-destructive",
        className,
      )}
      {...props}
    />
  );
}

function DropdownMenuSub({ ...props }: MenuPrimitive.SubmenuRoot.Props) {
  return <MenuPrimitive.SubmenuRoot data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  inset,
  children,
  ...props
}: MenuPrimitive.SubmenuTrigger.Props & {
  inset?: boolean;
}) {
  return (
    <MenuPrimitive.SubmenuTrigger
      data-slot="dropdown-menu-sub-trigger"
      data-inset={inset}
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-[13px] outline-hidden select-none coarse:min-h-11 focus:bg-accent focus:text-accent-foreground not-data-[variant=destructive]:focus:**:text-accent-foreground data-inset:pl-7 data-popup-open:bg-accent data-popup-open:text-accent-foreground data-open:bg-accent data-open:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRightIcon className="cn-rtl-flip ml-auto" />
    </MenuPrimitive.SubmenuTrigger>
  );
}

function DropdownMenuSubContent({
  align = "start",
  alignOffset = -3,
  side = "right",
  sideOffset = 0,
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuContent>) {
  return (
    <DropdownMenuContent
      data-slot="dropdown-menu-sub-content"
      className={cn("w-auto min-w-[96px]", className)}
      align={align}
      alignOffset={alignOffset}
      side={side}
      sideOffset={sideOffset}
      {...props}
    />
  );
}

/** A sheet row's trailing check; it marks the current choice where a menu shows its indicator. */
function SheetCheck({ checked }: { checked: boolean }) {
  return checked ? <CheckIcon aria-hidden className="ml-auto text-foreground!" /> : null;
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  inset,
  onCheckedChange,
  ...props
}: Omit<MenuPrimitive.CheckboxItem.Props, "onCheckedChange" | "className"> & {
  className?: string;
  inset?: boolean;
  onCheckedChange?: (checked: boolean) => void;
}) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <button
        type="button"
        data-slot="dropdown-menu-checkbox-item"
        aria-pressed={checked === true}
        disabled={props.disabled}
        onClick={() => onCheckedChange?.(checked !== true)}
        className={cn(SHEET_ITEM, className)}
      >
        {children}
        <SheetCheck checked={checked === true} />
      </button>
    );

  return (
    <MenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-[13px] outline-hidden select-none coarse:min-h-11 focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      checked={checked}
      onCheckedChange={onCheckedChange}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-checkbox-item-indicator"
      >
        <MenuPrimitive.CheckboxItemIndicator>
          <CheckIcon />
        </MenuPrimitive.CheckboxItemIndicator>
      </span>
      {children}
    </MenuPrimitive.CheckboxItem>
  );
}

/** A sheet's radio group: its value and how to change it, for the rows inside. */
const SheetRadioContext = React.createContext<{
  value: unknown;
  onValueChange?: (value: string) => void;
}>({ value: undefined });

function DropdownMenuRadioGroup({
  onValueChange,
  ...props
}: Omit<MenuPrimitive.RadioGroup.Props, "onValueChange"> & {
  onValueChange?: (value: string) => void;
}) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return (
      <SheetRadioContext value={{ value: props.value, onValueChange }}>
        <div role="group" aria-label={props["aria-label"]} data-slot="dropdown-menu-radio-group">
          {props.children}
        </div>
      </SheetRadioContext>
    );

  return (
    <MenuPrimitive.RadioGroup
      data-slot="dropdown-menu-radio-group"
      onValueChange={onValueChange}
      {...props}
    />
  );
}

function DropdownMenuRadioItem({
  className,
  children,
  inset,
  ...props
}: Omit<MenuPrimitive.RadioItem.Props, "className" | "value"> & {
  className?: string;
  inset?: boolean;
  value: string;
}) {
  const sheet = React.useContext(SheetContext);
  const group = React.useContext(SheetRadioContext);

  if (sheet !== null) {
    const checked = group.value === props.value;
    const Row = props.closeOnClick === true ? DrawerClose : "button";

    return (
      <Row
        type="button"
        data-slot="dropdown-menu-radio-item"
        aria-pressed={checked}
        disabled={props.disabled}
        onClick={() => group.onValueChange?.(props.value)}
        className={cn(SHEET_ITEM, className)}
      >
        {children}
        <SheetCheck checked={checked} />
      </Row>
    );
  }

  return (
    <MenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      data-inset={inset}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-8 pl-2 text-[13px] outline-hidden select-none coarse:min-h-11 focus:bg-accent focus:text-accent-foreground focus:**:text-accent-foreground data-inset:pl-7 data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span
        className="pointer-events-none absolute right-2 flex items-center justify-center"
        data-slot="dropdown-menu-radio-item-indicator"
      >
        <MenuPrimitive.RadioItemIndicator>
          <CheckIcon />
        </MenuPrimitive.RadioItemIndicator>
      </span>
      {children}
    </MenuPrimitive.RadioItem>
  );
}

function DropdownMenuSeparator({ className, ...props }: MenuPrimitive.Separator.Props) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null)
    return <div role="separator" className="mx-3 my-1.5 h-px shrink-0 bg-border" />;

  return (
    <MenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn("-mx-1 my-1 h-px bg-border", className)}
      {...props}
    />
  );
}

/** Keyboard hints; a sheet is for touch, which has no keys to hint at. */
function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<"span">) {
  const sheet = React.useContext(SheetContext);

  if (sheet !== null) return null;

  return (
    <span
      data-slot="dropdown-menu-shortcut"
      className={cn(
        "ml-auto pl-4 text-xs text-muted-foreground group-focus/dropdown-menu-item:text-accent-foreground",
        className,
      )}
      {...props}
    />
  );
}

export {
  createDropdownMenuHandle,
  DropdownMenu,
  DropdownMenuSheet,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};

const createDropdownMenuHandle = MenuPrimitive.createHandle;
