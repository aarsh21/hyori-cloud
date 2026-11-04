"use client";

import { Kbd } from "@hyori-cloud/ui/components/kbd";
import { cn } from "@hyori-cloud/ui/lib/utils";
import { SearchIcon, XIcon } from "lucide-react";
import * as React from "react";

const COMMIT_DELAY_MS = 180;

/**
 * Owns its draft so typing never rerenders the screen. Commits on a short trailing timer, and
 * immediately on Enter or clear, so each burst of typing produces one request. `value` is the search
 * actually applied: the draft follows it when the owner changes it, so the box never disagrees with
 * the results it describes.
 */
function SearchField({
  className,
  label,
  placeholder,
  shortcut,
  inputRef,
  value,
  onCommit,
}: {
  className?: string;
  label: string;
  placeholder: string;
  shortcut?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  value: string;
  onCommit: (value: string) => void;
}) {
  const [draft, setDraft] = React.useState(value);
  const [applied, setApplied] = React.useState(value);
  const timer = React.useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  if (value !== applied) {
    setApplied(value);

    // Our own commit arrives trimmed. Keep the draft, or typing a space between words would undo it.
    if (value !== draft.trim()) setDraft(value);
  }

  function commit(next: string) {
    clearTimeout(timer.current);
    onCommit(next.trim());
  }

  function clear() {
    setDraft("");
    commit("");
  }

  return (
    <search
      data-slot="search-field"
      className={cn(
        "group/search relative flex h-8 min-w-0 items-center rounded-lg border border-input bg-card transition-[background-color,border-color,box-shadow] duration-150 focus-within:border-ring focus-within:bg-card focus-within:ring-2 focus-within:ring-ring/25 coarse:h-10",
        className,
      )}
    >
      <SearchIcon
        aria-hidden
        strokeWidth={1.75}
        className="pointer-events-none absolute left-2.5 size-4 text-muted-foreground"
      />
      <input
        ref={inputRef}
        type="search"
        aria-label={label}
        placeholder={placeholder}
        value={draft}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          clearTimeout(timer.current);
          timer.current = setTimeout(() => onCommit(next.trim()), COMMIT_DELAY_MS);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") commit(draft);

          if (event.key === "Escape") {
            if (draft === "") event.currentTarget.blur();
            else clear();
          }
        }}
        className="h-full w-full min-w-0 bg-transparent pr-8 pl-8 text-[13px] outline-none placeholder:text-muted-foreground coarse:text-base [&::-webkit-search-cancel-button]:hidden"
      />
      {draft === "" && shortcut !== undefined ? (
        <Kbd className="pointer-events-none absolute right-1.5 group-focus-within/search:hidden">
          {shortcut}
        </Kbd>
      ) : null}
      {draft === "" ? null : (
        <button
          type="button"
          aria-label="Clear search"
          onClick={clear}
          className="absolute right-1 grid size-6 place-items-center rounded-sm text-muted-foreground outline-none after:absolute after:-inset-1.5 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon aria-hidden strokeWidth={1.75} className="size-3.5" />
        </button>
      )}
    </search>
  );
}

export { SearchField };
