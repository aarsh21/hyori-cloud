import { cn } from "@hyori-cloud/ui/lib/utils";
import { LoaderIcon } from "lucide-react";

function Spinner({ className, label = "Loading" }: { className?: string; label?: string }) {
  return (
    <LoaderIcon
      data-slot="spinner"
      role="status"
      aria-label={label}
      strokeWidth={1.75}
      className={cn(
        "size-4 animate-spin text-muted-foreground [animation-duration:700ms]",
        className,
      )}
    />
  );
}

export { Spinner };
