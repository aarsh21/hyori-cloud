"use client";

import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

/** A full-page document: a thin bar over content that takes all the remaining height. */
function HostedDocumentLayout({
  bar,
  children,
}: {
  bar: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div data-slot="hosted-document" className="flex h-dvh flex-col bg-background text-foreground">
      <header
        aria-label="Document controls"
        className="flex min-h-13 shrink-0 flex-wrap items-center gap-2 border-b border-border bg-card px-2 py-1.5 pt-[max(0.375rem,env(safe-area-inset-top))] sm:gap-3 sm:px-3"
      >
        {bar}
      </header>
      <main className="relative min-h-0 flex-1">{children}</main>
    </div>
  );
}

/**
 * An empty frame that hands itself to its owner once, when mounted, and is released just before it
 * leaves the DOM. It knows nothing about what's loaded in it: the owner navigates it, so it can
 * capture the frame's window before there's anything to load.
 */
function HostedDocumentFrame({
  title,
  onAttach,
  inert,
  className,
}: {
  title: string;
  onAttach: (frame: HTMLIFrameElement) => () => void;
  /** Takes the document out of focus and input while something covers it, without unloading it. */
  inert?: boolean;
  className?: string;
}) {
  // Kept from the first render: a new callback must not detach and reattach a live document.
  const [attach] = React.useState(() => onAttach);

  return (
    <iframe
      ref={attach}
      data-slot="hosted-document-frame"
      title={title}
      allow="clipboard-read; clipboard-write; fullscreen"
      inert={inert}
      className={cn("absolute inset-0 size-full border-0", className)}
    />
  );
}

/** Covers the frame while it has nothing to show, or nothing that's safe to keep working in. */
function HostedDocumentCover({ children }: { children: React.ReactNode }) {
  return (
    <div className="absolute inset-0 grid place-items-center overflow-auto bg-background p-4">
      {children}
    </div>
  );
}

function HostedDocumentIdentity({ children }: { children: React.ReactNode }) {
  return (
    <div data-slot="hosted-document-identity" className="flex min-w-0 flex-1 flex-col gap-0.5">
      {children}
    </div>
  );
}

function HostedDocumentStatus({ children }: { children: React.ReactNode }) {
  return (
    <div
      data-slot="hosted-document-status"
      role="status"
      aria-live="polite"
      aria-atomic="true"
      className="min-h-4.5 text-xs text-muted-foreground"
    >
      {children}
    </div>
  );
}

/** Neutral link mechanics, including when rendered as a menu item by the host. */
function HostedDocumentLink(props: React.ComponentProps<"a">) {
  return <a {...props} />;
}

export {
  HostedDocumentCover,
  HostedDocumentFrame,
  HostedDocumentIdentity,
  HostedDocumentLayout,
  HostedDocumentLink,
  HostedDocumentStatus,
};
