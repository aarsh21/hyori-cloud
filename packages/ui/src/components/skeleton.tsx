import { cn } from "@hyori-cloud/ui/lib/utils";

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="skeleton" className={cn("rounded-sm bg-muted", className)} {...props} />;
}

export { Skeleton };
