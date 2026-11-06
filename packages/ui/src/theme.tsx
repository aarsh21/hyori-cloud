"use client";

import { ThemeProvider, useTheme } from "next-themes";
import { useEffect, useSyncExternalStore, type ReactNode } from "react";

export type Appearance = "light" | "dark" | "system";

type AppearanceControl = {
  preference: Appearance | undefined;
  resolved: "light" | "dark" | undefined;
  setPreference: (preference: Appearance) => void;
};

const APPEARANCE_STORAGE_KEY = "hyori-appearance";

function subscribeToHydration() {
  return () => {};
}

function clientSnapshot() {
  return true;
}

function serverSnapshot() {
  return false;
}

/** Owns browser preference storage, OS subscriptions, and the pre-paint document script. */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider
      attribute="class"
      storageKey={APPEARANCE_STORAGE_KEY}
      defaultTheme="system"
      enableSystem
      enableColorScheme
      disableTransitionOnChange
    >
      {children}
    </ThemeProvider>
  );
}

/** Synchronizes an external host surface with the existing appearance owner, without owning its lifecycle. */
export function AppearanceObserver({ onChange }: { onChange: (appearance: Appearance) => void }) {
  const { preference, resolved } = useAppearance();

  // An embedded imperative surface cannot consume React context itself. No cache, protocol,
  // or save lifecycle lives here; resolved changes reapply System after an OS appearance change.
  useEffect(() => {
    if (preference !== undefined) onChange(preference);
  }, [preference, resolved, onChange]);

  return null;
}

/** The server snapshot also runs on the first hydration render, never reading browser state. */
export function useAppearance(): AppearanceControl {
  const { theme, resolvedTheme, setTheme, themes } = useTheme();
  const hydrated = useSyncExternalStore(subscribeToHydration, clientSnapshot, serverSnapshot);

  if (!hydrated || themes.length === 0) {
    return { preference: undefined, resolved: undefined, setPreference: setTheme };
  }

  return {
    preference: theme === "light" || theme === "dark" ? theme : "system",
    resolved: resolvedTheme === "dark" ? "dark" : "light",
    setPreference: setTheme,
  };
}
