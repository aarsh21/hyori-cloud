const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const monthFormat = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

const dateTimeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export const BYTES_PER_GB = 1024 ** 3;

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** exponent;

  return `${value >= 100 ? Math.round(value) : Number(value.toFixed(1))} ${UNITS[exponent]}`;
}

export function formatUsage(usedBytes: number, quotaBytes: number): string {
  return `${formatBytes(usedBytes)} of ${formatBytes(quotaBytes)} used`;
}

export function formatDate(iso: string): string {
  return dateFormat.format(new Date(iso));
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

export function isMediaType(mimeType: string): boolean {
  return mimeType.startsWith("image/") || mimeType.startsWith("video/");
}
