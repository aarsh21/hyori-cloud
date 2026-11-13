"use client";

import { useEffect, useState, type ComponentType } from "react";
import { Button } from "@hyori-cloud/ui/components/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@hyori-cloud/ui/components/dialog";
import { Spinner } from "@hyori-cloud/ui/components/spinner";

/** Loading and failure belong to the requested dialog, never to the surrounding workspace. */
export function DeferredDialog<Props extends object>({
  load,
  props,
  title,
  open,
  onClose,
}: {
  load: () => Promise<ComponentType<Props>>;
  props: Props;
  title: string;
  open: boolean;
  onClose: () => void;
}) {
  const [attempt, setAttempt] = useState(0);

  const [result, setResult] = useState<
    { component: ComponentType<Props> } | { failed: true } | null
  >(null);

  useEffect(() => {
    let current = true;
    void load().then(
      (component) => {
        if (current) setResult({ component });
      },
      () => {
        if (current) setResult({ failed: true });
      },
    );

    return () => {
      current = false;
    };
  }, [load, attempt]);

  if (result !== null && "component" in result) {
    const Content = result.component;

    return <Content {...props} />;
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="animate-none! transition-none!">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {result === null ? (
            <Spinner label="Opening dialog" />
          ) : (
            <DialogDescription role="alert">
              Couldn’t load this dialog. No changes were made. Try again when your connection is
              back.
            </DialogDescription>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          {result !== null ? (
            <Button
              onClick={() => {
                setResult(null);
                setAttempt(attempt + 1);
              }}
            >
              Try again
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
