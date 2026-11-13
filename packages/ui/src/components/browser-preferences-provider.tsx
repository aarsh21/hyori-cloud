import { createContext, use } from "react";
import {
  DEFAULT_BROWSER_PREFERENCES,
  type BrowserPreferences,
} from "@hyori-cloud/ui/lib/browser-preferences";

const BrowserPreferencesContext = createContext(DEFAULT_BROWSER_PREFERENCES);

/** The document's immutable request snapshot, also used for its first hydration render. */
export function BrowserPreferencesProvider({
  value,
  children,
}: {
  value: BrowserPreferences;
  children: React.ReactNode;
}) {
  return <BrowserPreferencesContext value={value}>{children}</BrowserPreferencesContext>;
}

export function useServerBrowserPreferences() {
  return use(BrowserPreferencesContext);
}
