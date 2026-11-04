import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** A single quiet column for moments with one job: setup, sign-in, an invite, a shared link. */
function FocusLayout({ className, children, ...props }: React.ComponentProps<"main">) {
  return (
    <main
      data-slot="focus-layout"
      className={cn(
        "flex min-h-svh flex-col items-center bg-background px-5 pt-[max(12svh,3rem)] pb-10",
        className,
      )}
      {...props}
    >
      <div className="flex w-full max-w-[22rem] flex-col gap-7">{children}</div>
    </main>
  );
}

function FocusLayoutHeader({ className, ...props }: React.ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

export { FocusLayout, FocusLayoutHeader };
