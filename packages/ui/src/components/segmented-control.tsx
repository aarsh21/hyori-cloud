"use client";

import { Toggle as TogglePrimitive } from "@base-ui/react/toggle";
import { ToggleGroup as ToggleGroupPrimitive } from "@base-ui/react/toggle-group";
import { AppLink } from "@hyori-cloud/ui/components/app-link";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

const trackClasses = "inline-flex shrink-0 items-center gap-0.5 rounded-md bg-muted p-0.5";

const segmentClasses =
  "inline-flex h-7 items-center justify-center gap-1.5 rounded-[5px] px-2 text-[13px] text-muted-foreground outline-none select-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40 coarse:h-9 [&_svg]:size-4 [&_svg]:stroke-[1.75]";

const selectedClasses = "bg-card font-medium text-foreground shadow-(--shadow-panel)";

/** Exactly one option is always selected. Selection changes are immediate: this is used constantly. */
function SegmentedControl<Value extends string>({
  className,
  label,
  value,
  onValueChange,
  children,
}: {
  className?: string;
  label: string;
  value: Value;
  onValueChange: (value: Value) => void;
  children: React.ReactNode;
}) {
  return (
    <ToggleGroupPrimitive
      data-slot="segmented-control"
      aria-label={label}
      value={[value]}
      onValueChange={(values) => {
        const next = values[0];

        if (next !== undefined) onValueChange(next);
      }}
      className={cn(trackClasses, className)}
    >
      {children}
    </ToggleGroupPrimitive>
  );
}

function SegmentedControlItem({
  className,
  value,
  label,
  children,
}: {
  className?: string;
  value: string;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <TogglePrimitive
      value={value}
      aria-label={label}
      title={label}
      className={cn(
        segmentClasses,
        "data-pressed:bg-card data-pressed:text-foreground data-pressed:shadow-(--shadow-panel)",
        className,
      )}
    >
      {children}
    </TogglePrimitive>
  );
}

function SegmentedNav({ className, ...props }: React.ComponentProps<"nav">) {
  return <nav data-slot="segmented-nav" className={cn(trackClasses, className)} {...props} />;
}

function SegmentedNavLink({
  className,
  current,
  ...props
}: React.ComponentProps<typeof AppLink> & { current: boolean }) {
  return (
    <AppLink
      aria-current={current ? "page" : undefined}
      className={cn(segmentClasses, "px-2.5", current && selectedClasses, className)}
      {...props}
    />
  );
}

export { SegmentedControl, SegmentedControlItem, SegmentedNav, SegmentedNavLink };
