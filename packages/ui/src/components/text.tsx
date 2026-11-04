import { cn } from "@hyori-cloud/ui/lib/utils";
import { cva, type VariantProps } from "class-variance-authority";
import * as React from "react";

const textVariants = cva("text-pretty", {
  variants: {
    size: {
      xs: "text-xs/relaxed",
      sm: "text-[13px]/relaxed",
      md: "text-sm/relaxed",
    },
    tone: {
      default: "text-foreground",
      muted: "text-muted-foreground",
      destructive: "text-destructive",
    },
    numeric: { true: "tabular-nums", false: "" },
    truncate: { true: "truncate", false: "" },
  },
  defaultVariants: { size: "sm", tone: "default", numeric: false, truncate: false },
});

type TextProps = React.ComponentProps<"p"> & VariantProps<typeof textVariants>;

function Text({ className, size, tone, numeric, truncate, ...props }: TextProps) {
  return (
    <p
      data-slot="text"
      className={cn(textVariants({ size, tone, numeric, truncate }), className)}
      {...props}
    />
  );
}

function InlineText({
  className,
  size,
  tone,
  numeric,
  truncate,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof textVariants>) {
  return (
    <span
      data-slot="inline-text"
      className={cn(textVariants({ size, tone, numeric, truncate }), className)}
      {...props}
    />
  );
}

function Heading({ className, ...props }: React.ComponentProps<"h1">) {
  return (
    <h1
      data-slot="heading"
      className={cn("text-xl font-semibold tracking-[-0.016em] text-balance", className)}
      {...props}
    />
  );
}

function SectionHeading({ className, ...props }: React.ComponentProps<"h2">) {
  return (
    <h2
      data-slot="section-heading"
      className={cn("text-[13px] font-medium tracking-[-0.003em] text-foreground", className)}
      {...props}
    />
  );
}

function Stack({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="stack" className={cn("flex flex-col", className)} {...props} />;
}

function Row({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="row" className={cn("flex items-center", className)} {...props} />;
}

export { Heading, InlineText, Row, SectionHeading, Stack, Text };
