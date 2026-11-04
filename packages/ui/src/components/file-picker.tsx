"use client";

import { cn } from "@hyori-cloud/ui/lib/utils";
import * as React from "react";

type FilePickerHandle = { open: () => void };

/** The hidden host file input. The caller supplies the visible control and calls `open()`. */
function FilePicker({
  ref,
  multiple = true,
  accept,
  onFiles,
}: {
  ref: React.Ref<FilePickerHandle>;
  multiple?: boolean;
  accept?: string;
  onFiles: (files: File[]) => void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  React.useImperativeHandle(ref, () => ({ open: () => input.current?.click() }), []);

  return (
    <input
      ref={input}
      type="file"
      tabIndex={-1}
      aria-hidden
      hidden
      multiple={multiple}
      accept={accept}
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        // Clearing lets the same file be chosen again, for example after a failed transfer.
        event.target.value = "";

        if (files.length > 0) onFiles(files);
      }}
    />
  );
}

/**
 * Accepts dropped files anywhere in its region. The overlay never shifts content and appears only
 * while a file drag is actually over the region; dragging text or links does nothing.
 */
function DropZone({
  className,
  label,
  disabled = false,
  onFiles,
  children,
}: {
  className?: string;
  label: string;
  disabled?: boolean;
  onFiles: (files: File[]) => void;
  children: React.ReactNode;
}) {
  const [dragging, setDragging] = React.useState(false);
  const depth = React.useRef(0);

  function carriesFiles(event: React.DragEvent) {
    return !disabled && event.dataTransfer.types.includes("Files");
  }

  return (
    <div
      role="none"
      data-slot="drop-zone"
      className={cn("relative flex min-h-0 flex-1 flex-col", className)}
      onDragEnter={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current += 1;
        setDragging(true);
      }}
      onDragOver={(event) => {
        if (carriesFiles(event)) event.preventDefault();
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event)) return;
        depth.current -= 1;

        if (depth.current <= 0) {
          depth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        depth.current = 0;
        setDragging(false);
        const files = Array.from(event.dataTransfer.files);

        if (files.length > 0) onFiles(files);
      }}
    >
      {children}
      {dragging ? (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-2 z-20 grid place-items-center rounded-lg border-2 border-dashed border-ring/50 bg-card/85 text-[13px] font-medium text-foreground"
        >
          {label}
        </div>
      ) : null}
    </div>
  );
}

export { DropZone, FilePicker };

export type { FilePickerHandle };
