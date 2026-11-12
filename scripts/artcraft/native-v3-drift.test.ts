import { expect, test } from "bun:test";
import { lineDelta, mergeOnto } from "./native-v3-drift.ts";

const lines = (edits: Record<number, string> = {}) =>
  Buffer.from(
    Array.from({ length: 12 }, (_, index) => edits[index] ?? `line ${index}`).join("\n") + "\n",
  );

const base = lines();
const fork = lines({ 3: "line 3 patched by the fork" });

test("an upstream edit away from the fork's anchor merges cleanly", async () => {
  expect(await mergeOnto(base, fork, lines({ 10: "upstream moved on" }))).toEqual({
    status: "clean",
  });
});

test("an upstream edit to the fork's anchor is one conflicting hunk", async () => {
  expect(await mergeOnto(base, fork, lines({ 3: "upstream rewrote line 3" }))).toEqual({
    status: "conflict",
    hunks: 1,
    lines: 2,
  });
});

test("an untouched or removed upstream file is reported as such", async () => {
  expect(await mergeOnto(base, fork, base)).toEqual({ status: "upstream-unchanged" });
  expect(await mergeOnto(base, fork, undefined)).toEqual({ status: "removed-upstream", lines: 2 });
});

test("line deltas count an added file whole", async () => {
  expect(await lineDelta(undefined, lines())).toEqual({ added: 12, removed: 0 });
});
