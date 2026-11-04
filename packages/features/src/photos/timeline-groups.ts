import type { FileEntry } from "@hyori-cloud/client-sdk";
import { formatMonth } from "#features/shared/format.ts";

export type TimelineGroup<Item> = { readonly title: string; readonly items: readonly Item[] };

/** The server orders the timeline. Grouping only labels runs of the same month in that order. */
export function groupByMonth<Item extends Pick<FileEntry, "createdAt">>(
  items: readonly Item[],
): readonly TimelineGroup<Item>[] {
  const groups: { title: string; items: Item[] }[] = [];

  for (const item of items) {
    const title = formatMonth(item.createdAt);
    const current = groups.at(-1);

    if (current?.title === title) current.items.push(item);
    else groups.push({ title, items: [item] });
  }

  return groups;
}
