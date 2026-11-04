/**
 * Host adapter over `localStorage` for a small JSON list. A null key stores nothing, for sessions
 * that must leave no trace in a shared browser. Contents are returned unvalidated: the owner of the
 * data decodes them. Storage may be blocked or full, so a failed write is left to the caller.
 */
export function createBrowserListStore(key: string | null) {
  return {
    read(): readonly unknown[] {
      if (key === null || typeof localStorage === "undefined") return [];
      const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? "[]");

      return Array.isArray(parsed) ? parsed : [];
    },
    write(values: readonly unknown[]) {
      if (key === null || typeof localStorage === "undefined") return;

      if (values.length === 0) localStorage.removeItem(key);
      else localStorage.setItem(key, JSON.stringify(values));
    },
  };
}
