import { expect, test } from "bun:test";
import {
  BYTES_PER_GB,
  endOfLocalDayIso,
  formatBytes,
  formatUsage,
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
