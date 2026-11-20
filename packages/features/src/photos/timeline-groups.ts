import {
  formatDate,
  formatDay,
  formatMonth,
  localDateInputValue,
} from "#features/shared/format.ts";

export type TimelineGroup<Item> = {
  /** The calendar day this run's items share, `YYYY-MM-DD`. Identity for a section, not text. */
  readonly key: string;
  /** "Today", "Yesterday", or the shortest date that isn't ambiguous. */
  readonly label: string;
  /** The month's name, set only on the first run of that month on screen. */
  readonly month: string | null;
  readonly items: readonly Item[];
};

function dayKeyAt(now: Date, dayOffset = 0): string {
  return localDateInputValue(
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + dayOffset),
  );
}

/**
 * The day a reader scans for: relative while fresh, then the shortest unambiguous date, matching
 * `formatRecentDate`'s rule for files. A `YYYY-MM-DD` key is a calendar date, never an instant, so
 * the label never re-derives a different day from a timezone.
 */
export function timelineDayLabel(key: string, now = new Date()): string {
  if (key === dayKeyAt(now)) return "Today";

  if (key === dayKeyAt(now, -1)) return "Yesterday";

  const date = new Date(`${key}T00:00:00`);

  return date.getFullYear() === now.getFullYear() ? formatDay(date) : formatDate(`${key}T00:00:00`);
}

/**
 * The server orders the timeline. Grouping only labels runs of the same day in that order, so a
 * day the order revisits gets a second run rather than a silent merge, and the first run of a
 * month carries the month's name.
 */
export function groupTimelineByDay<Item>(
  items: readonly Item[],
  dayKeyOf: (item: Item) => string,
  now = new Date(),
): readonly TimelineGroup<Item>[] {
  const groups: { key: string; label: string; month: string | null; items: Item[] }[] = [];

  for (const item of items) {
    const key = dayKeyOf(item);
    const current = groups.at(-1);

    if (current?.key === key) {
      current.items.push(item);
      continue;
    }

    groups.push({
      key,
      label: timelineDayLabel(key, now),
      month:
        current !== undefined && current.key.slice(0, 7) === key.slice(0, 7)
          ? null
          : formatMonth(`${key}T00:00:00`),
      items: [item],
    });
  }

  return groups;
}
