const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

const timeFormat = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const dayFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });

const relativeDayFormat = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export const BYTES_PER_GB = 1024 ** 3;

const MS_PER_DAY = 86_400_000;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${UNITS[exponent]}`;
}

/** For where the word "used" would push the numbers out of a narrow row. */
/** A folder's direct contents: "Empty", "1 item", "1,204 items". */
export function formatItemCount(count: number): string {
  if (count === 0) return "Empty";

  return `${count.toLocaleString("en-US")} ${count === 1 ? "item" : "items"}`;
}

export function formatStorage(usedBytes: number, quotaBytes: number): string {
  return `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)}`;
}

export function formatUsage(usedBytes: number, quotaBytes: number): string {
  return `${formatStorage(usedBytes, quotaBytes)} used`;
}

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
}

/** A day within the year it's shown beside: "Nov 3", never carrying the year itself. */
export function formatDay(date: Date): string {
  return dayFormat.format(date);
}

function localMidnight(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function capitalized(text: string): string {
  return text.charAt(0).toLocaleUpperCase() + text.slice(1);
}

/**
 * Scannable in a column: the time today, "Yesterday", then the shortest date that isn't ambiguous.
 * `formatDateTime` carries the exact moment wherever this appears.
 */
export function formatRecentDate(iso: string, now = new Date()): string {
  const date = new Date(iso);
  // Rounded, because a day that crosses a daylight-saving change isn't exactly 24 hours.
  const daysAgo = Math.round((localMidnight(now) - localMidnight(date)) / MS_PER_DAY);

  if (daysAgo === 0)
    return `${capitalized(relativeDayFormat.format(0, "day"))}, ${timeFormat.format(date)}`;

  if (daysAgo === 1) return capitalized(relativeDayFormat.format(-1, "day"));

  return date.getFullYear() === now.getFullYear()
    ? dayFormat.format(date)
    : dateFormat.format(date);
}

/** The same without the time, for one-line phone rows and tiles: "Today", "Yesterday", "Nov 3". */
export function formatRecentDay(iso: string, now = new Date()): string {
  const date = new Date(iso);

  if (localMidnight(now) === localMidnight(date))
    return capitalized(relativeDayFormat.format(0, "day"));

  return formatRecentDate(iso, now);
}

export function formatDateTime(iso: string): string {
  return dateTimeFormat.format(new Date(iso));
}

export function formatMonth(iso: string): string {
  return monthFormat.format(new Date(iso));
}

/** A date input means the whole of that local day, so a link set to expire "today" still works today. */
export function endOfLocalDayIso(date: string): string {
  return new Date(`${date}T23:59:59.999`).toISOString();
}

/** The local calendar day, in the form a date input takes. */
export function localDateInputValue(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  return `${date.getFullYear()}-${month}-${day}`;
}

export function isMediaType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}

const MEDIA_FORMAT_NAMES = new Map([
  ["3gpp", "3GP"],
  ["avif", "AVIF"],
  ["bmp", "BMP"],
  ["gif", "GIF"],
  ["heic", "HEIC"],
  ["heif", "HEIF"],
  ["jpeg", "JPEG"],
  ["mp4", "MP4"],
  ["mpeg", "MP3"],
  ["png", "PNG"],
  ["quicktime", "QuickTime"],
  ["svg+xml", "SVG"],
  ["tiff", "TIFF"],
  ["webm", "WebM"],
  ["webp", "WebP"],
  ["x-matroska", "Matroska"],
]);

/**
 * A person-readable type for detail rows: "JPEG photo", "MP4 video". Media keeps its everyday
 * format name; anything else stays the MIME string, because an invented label for an unknown type
 * reads worse than the raw value.
 */
export function formatMediaType(mimeType: string): string {
  const slash = mimeType.indexOf("/");

  if (slash < 0) return mimeType;

  const family = mimeType.slice(0, slash);
  const subtype = mimeType.slice(slash + 1);

  if (family !== "image" && family !== "video" && family !== "audio") return mimeType;

  const format = MEDIA_FORMAT_NAMES.get(subtype) ?? subtype.toUpperCase();
  const noun = family === "image" ? "photo" : family;

  return `${format} ${noun}`;
}
