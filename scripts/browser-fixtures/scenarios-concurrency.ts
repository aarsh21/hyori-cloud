import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { uploadFiles, uploadsTray } from "./page-actions.ts";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { createFolder, waitForTrayIdle } from "./scenarios-photos.ts";

const FILES_PER_SESSION = 24;

function percentile(values: readonly number[], share: number) {
  const sorted = values.toSorted((first, second) => first - second);

  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))] ?? 0;
}

/**
 * A failed upload's Retry pressed while both of the queue's slots are busy: the real queue, in a
 * real browser. The first request's refusal and the held parts are the gateway's; the rest is real.
 */
async function retryWaitingForSlot(run: CoreRun) {
  const { report, front, media } = run;
  const { context, page } = await ownerPage(run);

  await page.getByRole("link", { name: "Files" }).first().click();
  await createFolder(page, "Waiting");

  const names = ["slot-a.bin", "slot-b.bin", "slot-c.bin"];
  const files = names.map((name) => media.bytes(name, 64 * 1024));

  const isBegin =
    (name: string) => (record: { operation: string | null; rpcBody: string | null }) =>
      record.operation === "uploads.begin" && (record.rpcBody ?? "").includes(`"${name}"`);

  front.clearFaults();
  front.resetCounters();
  front.refuse(isBegin("slot-a.bin"));

  const release = front.hold(({ operation }) => operation === "uploads.part", 2);

  try {
    await uploadFiles(page, files);

    const tray = uploadsTray(page);
    const retry = tray.getByRole("button", { name: "Retry upload of slot-a.bin" });

    await retry.waitFor();

    const heldParts = async () =>
      front.records.filter(({ operation }) => operation === "uploads.part").length;

    await expectSoon(async () => (await heldParts()) === 2, "both slots never filled");

    await report.check(
      "a Retry waiting for a slot says so, keeps focus, and starts nothing",
      async () => {
        await retry.focus();
        await page.keyboard.press("Enter");
        await tray.getByText("Waiting to retry").waitFor();
        assert.equal(await retry.getAttribute("aria-busy"), "true");
        assert.equal(
          await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
          "Retry upload of slot-a.bin",
        );
        await page.keyboard.press("Enter");
        await page.waitForTimeout(300);
        assert.equal(
          front.records.filter(isBegin("slot-a.bin")).length,
          1,
          "a third transfer began",
        );
      },
    );
  } finally {
    release();
  }

  await report.check("when a slot frees up, the waiting Retry runs once and finishes", async () => {
    assert.equal(await waitForTrayIdle(run, page, names.length), 0);
    assert.equal(front.records.filter(isBegin("slot-a.bin")).length, 2);
  });

  front.clearFaults();
  await context.close();
}

async function expectSoon(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;

  while (Date.now() < deadline) {
    if (await check()) return;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(message);
}

/**
 * Two signed-in sessions uploading ordinary new files into one folder at once, each picking files
 * the way a person does. None of this is a conflict, so any 409 here is a defect.
 */
export async function runConcurrentUploadScenario(run: CoreRun) {
  const { report, front, media } = run;

  await report.scenario("Retry while both upload slots are busy", () => retryWaitingForSlot(run));

  await report.scenario("Ordinary concurrent uploads: two sessions, one folder", async () => {
    const first = await ownerPage(run);
    const second = await ownerPage(run);

    await first.page.getByRole("link", { name: "Files" }).first().click();
    await createFolder(first.page, "Concurrent");
    await second.page.goto(first.page.url());
    await second.page.getByRole("heading", { name: "Concurrent" }).waitFor();

    const pattern = media.png("concurrent-pattern.png", 3, "640x480");

    const copies = (session: string) =>
      Array.from({ length: FILES_PER_SESSION }, (_, index) => {
        const copy = join(media.directory, `${session}-${String(index).padStart(2, "0")}.png`);

        copyFileSync(pattern, copy);

        return copy;
      });

    front.resetCounters();
    await Promise.all([
      uploadFiles(first.page, copies("first")),
      uploadFiles(second.page, copies("second")),
    ]);

    const retries = await Promise.all([
      waitForTrayIdle(run, first.page, FILES_PER_SESSION),
      waitForTrayIdle(run, second.page, FILES_PER_SESSION),
    ]);

    const writes = front.records.filter(
      ({ operation }) => operation === "uploads.begin" || operation === "uploads.complete",
    );

    const durations = writes.map(({ durationMs }) => durationMs);

    report.observe("concurrent upload writes", {
      writes: writes.length,
      p50Ms: percentile(durations, 0.5),
      p95Ms: percentile(durations, 0.95),
      maxMs: percentile(durations, 1),
      overOneSecond: durations.filter((duration) => duration >= 1000).length,
      statuses: writes.map(({ status }) => status).filter((status) => status !== 200),
      rowsNeedingRetry: retries,
    });

    await report.check("no ordinary upload needed a Retry", () => {
      assert.deepEqual(retries, [0, 0]);
    });

    await report.check("the backend reported no conflict or unavailability", () => {
      assert.deepEqual(
        writes
          .filter(({ status }) => status !== 200)
          .map(({ status, errorBody }) => ({ status, errorBody })),
        [],
      );
    });

    await report.check("every file committed exactly once", () => {
      const committed = writes.filter(
        ({ operation, status }) => operation === "uploads.complete" && status === 200,
      );

      assert.equal(committed.length, FILES_PER_SESSION * 2);
    });

    await report.shot(first.page, "concurrent-uploads-finished");
    await first.context.close();
    await second.context.close();
  });
}
