// Presentation-cookie codes only; the feature's RPC input remains Rust-derived.
const FILE_SORTS = [
  "nameAsc",
  "nameDesc",
  "sizeAsc",
  "sizeDesc",
  "modifiedAsc",
  "modifiedDesc",
] as const;

export type BrowserPreferences = {
  layout: "list" | "grid";
  sidebarOpen: boolean;
  singleKeyShortcuts: boolean;
  fileSort: (typeof FILE_SORTS)[number];
};

export const DEFAULT_BROWSER_PREFERENCES: BrowserPreferences = {
  layout: "list",
  sidebarOpen: true,
  singleKeyShortcuts: true,
  fileSort: "nameAsc",
};

const COOKIE = "hyori_ui";

/** Untrusted, versioned presentation input only. Reject the whole value, not individual fields. */
export function parseBrowserPreferences(value: string | null | undefined): BrowserPreferences {
  if (
    !value ||
    value.length !== (value[0] === "1" ? 7 : 9) ||
    !/^(?:1\.[lg]\.[oc]\.[01]|2\.[lg]\.[oc]\.[01]\.[0-5])$/.test(value)
  )
    return DEFAULT_BROWSER_PREFERENCES;

  return {
    layout: value[2] === "g" ? "grid" : "list",
    sidebarOpen: value[4] === "o",
    singleKeyShortcuts: value[6] === "1",
    fileSort: value[0] === "1" ? "nameAsc" : FILE_SORTS[Number(value[8])]!,
  };
}

export function encodeBrowserPreferences(preferences: BrowserPreferences) {
  return `2.${preferences.layout === "grid" ? "g" : "l"}.${preferences.sidebarOpen ? "o" : "c"}.${preferences.singleKeyShortcuts ? "1" : "0"}.${FILE_SORTS.indexOf(preferences.fileSort)}`;
}

export function browserPreferencesFromCookie(header: string) {
  const values = header.split(";").map((part) => part.trimStart());
  const matches = values.filter((part) => part.startsWith(`${COOKIE}=`));

  // Ambiguous path/domain copies must not pick an arbitrary preference snapshot.
  return parseBrowserPreferences(
    matches.length === 1 ? matches[0]!.slice(COOKIE.length + 1) : null,
  );
}

/** Browser-owned choices, shared across accounts like the existing localStorage keys.
 * No identity, file identifiers, session values or authorization decisions belong here.
 */
export function mirrorBrowserPreferences(overrides: Partial<BrowserPreferences> = {}) {
  let preferences = DEFAULT_BROWSER_PREFERENCES;

  try {
    preferences = {
      layout: localStorage.getItem("hyori-item-layout") === "grid" ? "grid" : "list",
      sidebarOpen: localStorage.getItem("hyori-sidebar") !== "collapsed",
      singleKeyShortcuts: localStorage.getItem("hyori-single-key-shortcuts") !== "off",
      fileSort:
        FILE_SORTS.find((sort) => sort === localStorage.getItem("hyori-file-sort")) ?? "nameAsc",
    };
  } catch {
    // Match the adapters' defaults when browser storage is blocked.
  }

  try {
    document.cookie = `${COOKIE}=${encodeBrowserPreferences({ ...preferences, ...overrides })}; Path=/; Max-Age=31536000; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
  } catch {
    // A blocked cookie keeps the pre-paint mismatch guard on subsequent visits.
  }
}
