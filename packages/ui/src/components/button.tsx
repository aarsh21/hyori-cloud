import { Button as ButtonPrimitive } from "@base-ui/react/button";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-[13px] font-medium whitespace-nowrap transition-[scale,background-color,border-color,box-shadow,color,opacity] duration-150 ease-(--ease-out) outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background active:not-aria-[haspopup]:scale-[0.98] disabled:pointer-events-none disabled:opacity-50 aria-busy:opacity-70 aria-invalid:border-destructive aria-invalid:ring-2 aria-invalid:ring-destructive/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg]:stroke-[1.75] [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-primary-foreground shadow-(--shadow-control-strong) hover:bg-primary/90",
        outline:
          "border-border bg-card text-foreground shadow-(--shadow-control) hover:bg-accent aria-expanded:bg-accent",
        secondary: "bg-secondary text-secondary-foreground hover:bg-accent aria-expanded:bg-accent",
        ghost:
          "text-muted-foreground hover:bg-accent hover:text-foreground aria-expanded:bg-accent aria-expanded:text-foreground",
        destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
        "destructive-outline":
          "border-border bg-card text-destructive shadow-(--shadow-control) hover:bg-destructive/8",
        link: "text-foreground underline underline-offset-4 decoration-border hover:decoration-foreground",
      },
      size: {
        default:
          "h-8 gap-1.5 px-3 coarse:h-11 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        xs: "h-6 gap-1 rounded-md px-2 text-xs coarse:h-11 coarse:px-3 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1 px-2.5 coarse:h-11 coarse:px-3 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 px-4 text-sm coarse:h-11",
        icon: "size-8 coarse:size-11",
        "icon-xs": "size-6 rounded-md coarse:size-11 [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 coarse:size-11",
        "icon-lg": "size-10 coarse:size-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

type ButtonProps = ButtonPrimitive.Props &
  VariantProps<typeof buttonVariants> & {
    /** Mutation in flight. Blocks repeat activation but keeps focus on the trigger. */
    pending?: boolean;
    /** Replaces the label while pending. Both labels reserve width so neighbours never move. */
    pendingLabel?: string;
  };

function Button({
  className,
  variant = "default",
  size = "default",
  pending = false,
  pendingLabel,
  children,
  disabled,
  ...props
}: ButtonProps) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      disabled={disabled || pending}
      focusableWhenDisabled={pending}
      aria-busy={pending || undefined}
      {...props}
    >
      {pendingLabel === undefined ? (
        children
      ) : (
        <span className="inline-grid justify-items-center">
          <span
            className={cn(
              "col-start-1 row-start-1 inline-flex items-center gap-1.5",
              pending && "invisible",
            )}
          >
            {children}
          </span>
          <span
            className={cn("col-start-1 row-start-1", !pending && "invisible")}
            aria-hidden={!pending}
          >
            {pendingLabel}
          </span>
        </span>
      )}
    </ButtonPrimitive>
  );
}

export { Button, buttonVariants };
