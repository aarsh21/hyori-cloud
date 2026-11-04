import { cn } from "@hyori-cloud/ui/lib/utils";

function Wordmark({ className }: { className?: string }) {
  return (
    <span
      data-slot="wordmark"
      className={cn(
        "inline-flex items-center gap-2 text-[14px] font-semibold tracking-[-0.012em] text-foreground select-none",
        className,
      )}
    >
      <span
        aria-hidden
        className="grid size-[18px] place-items-center rounded-[5px] bg-primary text-[11px] leading-none font-semibold text-primary-foreground"
      >
        h
      </span>
      Hyori
    </span>
  );
}

export { Wordmark };
