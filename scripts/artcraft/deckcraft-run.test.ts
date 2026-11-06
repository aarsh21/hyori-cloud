import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkDeckCraftRun, deckRunRoot } from "./deckcraft-run.ts";

test("recorded modified build evidence verifies offline and preserves deployment gates", async () => {
  const run = await checkDeckCraftRun();
  expect(run.deployable).toBe(false);
  expect(run.nativeSyntheticBrowserReopenPassed).toBe(true);
  expect(run.cloudPersistenceVerified).toBe(false);
  expect(run.pptxFidelityVerified).toBe(false);
});

test("altered bridge source and false deployment claims cannot pass retained-run checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "hyori-deck-run-test-"));

  try {
    await cp(deckRunRoot, directory, { recursive: true });
    const path = join(directory, "host-bridge.js.source");
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("\nchanged\n")]));
    await expect(checkDeckCraftRun(directory)).rejects.toThrow("checksum mismatch");
    await writeFile(path, original);
    const run = await checkDeckCraftRun(directory);
    await writeFile(join(directory, "result.json"), JSON.stringify({ ...run, deployable: true }));
    await expect(checkDeckCraftRun(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
