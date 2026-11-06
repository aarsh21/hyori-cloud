import { expect, test } from "bun:test";
import {
  BYTES_PER_GB,
  endOfLocalDayIso,
  formatBytes,
  formatRecentDate,
  formatUsage,
  localDateInputValue,
} from "#features/shared/format.ts";

test("formats sizes without false precision", () => {
  expect(formatBytes(0)).toBe("0 B");
  expect(formatBytes(1023)).toBe("1023 B");
  expect(formatBytes(1024)).toBe("1 KB");
  expect(formatBytes(1536)).toBe("1.5 KB");
  expect(formatBytes(BYTES_PER_GB * 250)).toBe("250 GB");
});

test("usage is plain text", () => {
  expect(formatUsage(BYTES_PER_GB, BYTES_PER_GB * 50)).toBe("1 GB of 50 GB used");
});

test("expiry covers the chosen local day", () => {
  const iso = endOfLocalDayIso("2030-06-15");
  const local = new Date(iso);
  expect(local.getDate()).toBe(15);
  expect(local.getHours()).toBe(23);
});

test("recent dates shorten as they get closer, without ever being ambiguous", () => {
  const now = new Date(2026, 10, 5, 15, 0);

  expect(formatRecentDate(new Date(2026, 10, 5, 9, 30).toISOString(), now)).toContain("9:30");
  expect(formatRecentDate(new Date(2026, 10, 4, 23, 59).toISOString(), now)).toBe("Yesterday");
  expect(formatRecentDate(new Date(2026, 2, 8, 12).toISOString(), now)).not.toContain("2026");
  expect(formatRecentDate(new Date(2025, 2, 8, 12).toISOString(), now)).toContain("2025");
});

test("a date input's value is the local calendar day", () => {
  expect(localDateInputValue(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
});
