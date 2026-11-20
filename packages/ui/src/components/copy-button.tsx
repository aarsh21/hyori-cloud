"use client";

import { Button } from "@hyori-cloud/ui/components/button";
import { Input } from "@hyori-cloud/ui/components/input";
import { copyText } from "@hyori-cloud/ui/lib/browser";
import { CheckIcon, CopyIcon } from "lucide-react";
import * as React from "react";

const FEEDBACK_MS = 1500;

type CopyState = "idle" | "copied" | "failed";

/**
 * Copies exactly `value`. Feedback is optimistic state tied to the transition's lifetime and reverts
 * by itself without timers to clean up.
 */
function CopyButton({
  value,
  label = "Copy",
  variant = "outline",
  size = "default",
}: {
  value: string;
  label?: string;
  variant?: React.ComponentProps<typeof Button>["variant"];
  size?: React.ComponentProps<typeof Button>["size"];
}) {
  const [state, setState] = React.useOptimistic<CopyState>("idle");
  const [, startTransition] = React.useTransition();

  return (
    <Button
      type="button"
      variant={variant}
      size={size}
      onClick={() => {
        startTransition(async () => {
          setState("copied");

          try {
            await copyText(value);
          } catch {
            // Code after an await has left the action's scope, so it needs its own transition.
            startTransition(() => setState("failed"));
          }

          await new Promise((resolve) => setTimeout(resolve, FEEDBACK_MS));
        });
      }}
    >
      <span className="inline-grid justify-items-center">
        <span
          className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${state === "idle" ? "" : "invisible"}`}
        >
          <CopyIcon aria-hidden className="size-3.5" />
          {label}
        </span>
        <span
          aria-live="polite"
          className={`col-start-1 row-start-1 inline-flex items-center gap-1.5 ${state === "idle" ? "invisible" : ""}`}
        >
          {state === "copied" ? <CheckIcon aria-hidden className="size-3.5" /> : null}
          {state === "failed" ? "Can’t copy" : null}
          {state === "copied" ? "Copied" : null}
        </span>
      </span>
    </Button>
  );
}

/**
 * A value people need to take elsewhere. It stays visible and selectable, because the clipboard API
 * is unavailable on plain-HTTP self-hosted installs and the value must never be unreachable. The
 * input clips long values, so its title carries the whole thing on hover.
 */
function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div data-slot="copy-field" className="flex min-w-0 gap-2">
      <Input
        readOnly
        value={value}
        aria-label={label}
        title={value}
        onFocus={(event) => event.target.select()}
        className="min-w-0 flex-1 tabular-nums"
      />
      <CopyButton value={value} />
    </div>
  );
}

/** For links shown only once. Only rendered after a client-side action, so reading the document is safe. */
function LinkField({ value, label }: { value: string; label: string }) {
  return <CopyField value={new URL(value, document.baseURI).href} label={label} />;
}

export { CopyButton, CopyField, LinkField };
