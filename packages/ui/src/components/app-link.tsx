"use client";

import * as React from "react";

/**
 * A real anchor (open in new tab, copy link, screen-reader semantics) that hands ordinary clicks to
 * the injected navigation capability. The router stays outside the design system.
 */
function AppLink({
  href,
  onNavigate,
  onClick,
  ...props
}: Omit<React.ComponentProps<"a">, "href"> & {
  href: string;
  onNavigate: (href: string) => void;
}) {
  return (
    <a
      data-slot="app-link"
      href={href}
      onClick={(event) => {
        onClick?.(event);
        const modified = event.metaKey || event.ctrlKey || event.shiftKey || event.altKey;

        if (event.defaultPrevented || modified || event.button !== 0) return;
        event.preventDefault();
        onNavigate(href);
      }}
      {...props}
    />
  );
}

export { AppLink };
