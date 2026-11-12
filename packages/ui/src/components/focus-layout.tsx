import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** A single quiet column for moments with one job: setup, sign-in, an invite, a shared link. */
function FocusLayout({
  className,
  children,
  footer,
  ...props
}: React.ComponentProps<"main"> & { footer?: React.ReactNode }) {
  return (
    <main
      data-slot="focus-layout"
      className={cn(
        "flex min-h-svh flex-col items-center bg-background px-5 pt-[max(12svh,3rem)] pb-[max(2.5rem,env(safe-area-inset-bottom))]",
        className,
      )}
      {...props}
    >
      <div className="flex w-full max-w-[22rem] flex-col gap-7">{children}</div>
      {footer === undefined ? null : <div className="mt-8">{footer}</div>}
    </main>
  );
}

function FocusLayoutHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export { FocusLayout, FocusLayoutHeader };
