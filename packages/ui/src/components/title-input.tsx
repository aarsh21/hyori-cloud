import { cn } from "@hyori-cloud/ui/lib/utils";
import type { ComponentProps } from "react";

type TitleInputProps = Omit<ComponentProps<"textarea">, "value" | "rows"> & {
  value: string;
  /** Titles are one paragraph: Enter hands off instead of breaking the line. */
  onEnter(field: HTMLTextAreaElement): void;
  onEscape(): void;
};

/**
 * A borderless document title that wraps like the heading it replaces. The invisible copy behind
 * the field sizes it to its wrapped text, so it grows on every engine without measuring.
 */
export function TitleInput({
  className,
  value,
  onEnter,
  onEscape,
  onKeyDown,
  ...props
}: TitleInputProps) {
  const field = "col-start-1 row-start-1 wrap-anywhere whitespace-pre-wrap";

  return (
    <span data-slot="title-input" className={cn("grid w-full", className)}>
      <span aria-hidden className={cn(field, "invisible")}>
        {`${value || props.placeholder || ""} `}
      </span>
      <textarea
        rows={1}
        value={value}
        className={cn(
          field,
          "resize-none overflow-hidden bg-transparent p-0 outline-none placeholder:text-muted-foreground/60",
        )}
        onKeyDown={(event) => {
          onKeyDown?.(event);

          if (event.defaultPrevented || event.nativeEvent.isComposing) return;

          if (event.key === "Enter") {
            event.preventDefault();
            onEnter(event.currentTarget);
          } else if (event.key === "Escape") {
            event.preventDefault();
            onEscape();
          }
        }}
        {...props}
      />
    </span>
  );
}
