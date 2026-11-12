import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/**
 * Uncontrolled form: the browser owns field values (and password-manager integration) and the
 * submit handler receives them once. Typing never rerenders the form.
 */
function Form({
  className,
  onValues,
  ...props
}: Omit<React.ComponentProps<"form">, "onSubmit"> & { onValues: (values: FormData) => void }) {
  return (
    <form
      data-slot="form"
      method="post"
      className={cn("flex flex-col gap-4", className)}
      onSubmit={(event) => {
        event.preventDefault();
        onValues(new FormData(event.currentTarget));
      }}
      {...props}
    />
  );
}

function Field({ className, ...props }: React.ComponentProps<"div">) {
  return <div data-slot="field" className={cn("flex flex-col gap-1.5", className)} {...props} />;
}

function FieldDescription({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-description"
      className={cn("text-xs/relaxed text-pretty text-muted-foreground", className)}
      {...props}
    />
  );
}

function FieldError({ className, ...props }: React.ComponentProps<"p">) {
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn("text-xs/relaxed text-pretty text-destructive", className)}
      {...props}
    />
  );
}

export { Field, FieldDescription, FieldError, Form };
