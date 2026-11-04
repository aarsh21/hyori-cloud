import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@hyori-cloud/ui/components/empty";
import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/**
 * The shared frame for empty, failed, offline, and not-requested regions. Every state sits in the
 * same place in the content area so moving between them never relocates the reader's attention.
 */
function RegionState({
  className,
  icon,
  title,
  description,
  action,
  role,
}: {
  className?: string;
  icon: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  role?: "alert" | "status";
}) {
  return (
    <Empty
      data-slot="region-state"
      role={role}
      className={cn("min-h-64 justify-start pt-[14svh] pb-10 md:p-6 md:pt-[14svh]", className)}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon" className="[&_svg]:stroke-[1.5]">
          {icon}
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        {description === undefined ? null : <EmptyDescription>{description}</EmptyDescription>}
      </EmptyHeader>
      {action === undefined ? null : <EmptyContent>{action}</EmptyContent>}
    </Empty>
  );
}

export { RegionState };
