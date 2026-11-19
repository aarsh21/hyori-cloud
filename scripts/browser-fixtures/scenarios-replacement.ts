import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { sha256 } from "./media.ts";
import { chooseWith, downloadHash, rowMenu, uploadFiles, uploadsTray } from "./page-actions.ts";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import type { Observed } from "./run-report.ts";

const MIB = 1024 * 1024;

async function clearTray(page: Page) {
  await uploadsTray(page).getByRole("button", { name: "Clear" }).click();
  await uploadsTray(page).waitFor({ state: "detached" });
}

async function uploadTarget(run: CoreRun, page: Page, name: string, size: number) {
  const path = run.media.bytes(name, size);

  await uploadFiles(page, path);
  await uploadsTray(page).getByLabel("Uploaded").waitFor({ timeout: 60_000 });
  await clearTray(page);

  return path;
}

async function startNewVersion(page: Page, target: string, source: string) {
  await rowMenu(page, target, "Upload new version…");

  const dialog = page.getByRole("dialog");

  await dialog.getByText("No file chosen").waitFor();
  await chooseWith(
    page,
    () => dialog.getByRole("button", { name: "Choose file…" }).click(),
    source,
  );
}

function confirmNewVersion(page: Page) {
  return page.getByRole("dialog").getByRole("button", { name: "Upload new version" }).click();
}

function downloadRow(page: Page, name: string) {
  return downloadHash(page, () => rowMenu(page, name, "Download"));
}

async function pauseReloadResume(run: CoreRun) {
  const { report, front, media, stack } = run;
  const { context, page } = await ownerPage(run);
  const target = "release.bin";
  const targetPath = await uploadTarget(run, page, target, 8 * MIB + 4096);
  const source = media.bytes("locally-edited copy.bin", 8 * MIB + 9000);

  // Has the target's name but other bytes, in its own directory so the original stays on disk.
  const impostor = media.bytes(`impostor/${target}`, 8 * MIB + 9000);

  await report.check("choosing a file starts nothing until it's confirmed", async () => {
    const begins = () =>
      front.records.filter((record) => record.operation === "uploads.begin").length;

    const before = begins();

    await startNewVersion(page, target, source);
    await page.getByText("It will be saved as “release.bin”.").waitFor();
    assert.deepEqual(begins(), before, "begins before confirming");
  });

  await report.shot(page, "replace-dialog-desktop");

  // Part 1 is acknowledged; the request for part 2 waits before any of its bytes reach the server.
  const releasePart = front.hold(
    (record) =>
      record.operation === "uploads.part" && /"partNumber":2\b/.test(record.rpcBody ?? ""),
  );

  await confirmNewVersion(page);

  const tray = uploadsTray(page);

  await report.check("the tray shows the target's name and that it's a new version", async () => {
    await tray.getByText(target).waitFor();
    await tray.getByText("New version").waitFor();
    assert.ok(!(await tray.innerText()).includes("locally-edited"), "local name shown in the row");
  });

  await report.check("the first part is really acknowledged before pausing", async () => {
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-label="Pause upload of release.bin"]');

      return button !== null && !button.hasAttribute("disabled");
    });
    await tray.getByText(/\d+% · /).waitFor();
  });

  await report.shot(page, "replace-uploading-desktop");

  await report.check(
    "Pause keeps keyboard focus on the same control as it becomes Resume",
    async () => {
      const pause = tray.getByRole("button", { name: `Pause upload of ${target}` });

      await pause.focus();
      await page.keyboard.press("Enter");
      await tray.getByText(/Paused at/).waitFor();

      const focused = await page.evaluate(() => document.activeElement?.getAttribute("aria-label"));

      assert.deepEqual(focused, `Resume upload of ${target}`, "focused control");
    },
  );

  releasePart();

  await report.check("a reload offers the original file by its own name, tagged", async () => {
    await page.reload();
    await tray
      .getByText("Interrupted. Choose “locally-edited copy.bin” again to continue.")
      .waitFor();
    await tray.getByText("New version").waitFor();
    await tray.getByText(target, { exact: true }).waitFor();
  });

  await report.check("the Rust server restarts underneath", () => stack.restartServer());

  const choose = (file: string) =>
    chooseWith(page, () => tray.getByRole("button", { name: "Choose file" }).click(), file);

  await report.check("a same-named file that isn't the original is refused", async () => {
    await choose(impostor);
    await tray
      .getByText(
        "That isn’t the same file. Choose “locally-edited copy.bin”, unchanged, to continue.",
      )
      .waitFor();
  });

  await report.check("the original resumes without beginning again, and commits", async () => {
    const begins = () => front.records.filter((record) => record.operation === "uploads.begin");
    const before = begins().length;

    await choose(source);
    await tray.getByLabel("Uploaded").waitFor({ timeout: 60_000 });
    assert.deepEqual(begins().length, before, "new uploads begun");
    await clearTray(page);
  });

  await report.check("a real download of it has the new bytes", async () => {
    assert.deepEqual(await downloadRow(page, target), sha256(source), "downloaded digest");
  });

  await report.check(
    "history has exactly one earlier version, and restoring brings back its bytes",
    async () => {
      await rowMenu(page, target, "Version history…");

      const dialog = page.getByRole("dialog");

      await dialog.getByText("Current", { exact: true }).waitFor();
      await dialog.getByRole("button", { name: "Restore" }).waitFor();
      assert.deepEqual(
        await dialog.getByRole("button", { name: "Restore" }).count(),
        1,
        "earlier versions",
      );
      await report.shot(page, "version-history-desktop");
      await dialog.getByRole("button", { name: "Restore" }).click();
      await page.getByText(/Restored the version from/).waitFor();
      await dialog.getByRole("button", { name: "Close" }).click();
      await dialog.waitFor({ state: "detached" });
      assert.deepEqual(await downloadRow(page, target), sha256(targetPath), "restored digest");
    },
  );

  await context.close();
}

/**
 * A baseline of today's behavior, not a pass: the server is restarted while it's midway through
 * receiving a part. What the person sees, and when a retry starts working, is what matters here.
 */
async function restartMidPart(run: CoreRun) {
  const { report, front, media, stack } = run;
  const { context, page } = await ownerPage(run);
  const target = "restart-target.bin";

  await uploadTarget(run, page, target, 64 * 1024);

  const source = media.bytes("restart-source.bin", 8 * MIB + 2048);

  const release = front.stallBody(
    (record) => record.method === "PUT" && /\/2(\?|$)/.test(record.path),
  );

  await startNewVersion(page, target, source);
  await confirmNewVersion(page);

  const tray = uploadsTray(page);

  await page.waitForFunction(
    () => document.querySelector('[aria-label="Uploads"]')?.textContent?.includes("%") === true,
  );
  await page.waitForTimeout(800);
  await stack.restartServer();
  release();

  const message = tray.getByText(/Couldn’t confirm the new version/);
  const committed = tray.getByLabel("Uploaded");

  await message.or(committed).first().waitFor({ timeout: 90_000 });
  await report.shot(page, "replace-restart-mid-part");

  const attempts: { readonly secondsAfterRestart: number; readonly result: string }[] = [];
  const startedAt = Date.now();

  // The SDK may already have recovered by itself, with nothing asked of the person.
  while ((await committed.count()) === 0 && Date.now() - startedAt < 240_000) {
    const before = front.trace.length;

    await tray.getByRole("button", { name: `Retry upload of ${target}` }).click();
    await committed.or(message).first().waitFor({ timeout: 30_000 });

    const statuses = front.trace
      .slice(before)
      .filter((record) => record.method === "PUT")
      .map((record) => record.status);

    attempts.push({
      secondsAfterRestart: Math.round((Date.now() - startedAt) / 1000),
      result: (await committed.count()) > 0 ? "committed" : `PUT ${statuses.join(",") || "none"}`,
    });

    if ((await committed.count()) === 0) await page.waitForTimeout(30_000);
  }

  report.observe("retries a person needed after a restart mid-part", attempts);

  await report.check("the same upload commits after a restart mid-part", async () => {
    assert.ok((await committed.count()) > 0, "still failing after four minutes");
    assert.equal(await downloadRow(page, target), sha256(source), "stored digest");
  });

  await context.close();
}

/** Comparable between protocols: one canceled download has been seen, and one isn't a pattern. */
async function repeatedDownloads(run: CoreRun) {
  const { report, front } = run;
  const { context, page } = await ownerPage(run);
  const name = "repeat-download.bin";
  const path = await uploadTarget(run, page, name, 8 * MIB + 4096);
  const attempts = 10;
  const results: string[] = [];

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      assert.equal(await downloadRow(page, name), sha256(path));
      results.push("ok");
    } catch (error) {
      results.push(error instanceof Error ? error.message.slice(0, 60) : "failed");
    }
  }

  const gets = front.trace
    .filter((record) => record.path.startsWith("/api/storage/files/"))
    .slice(-attempts);

  report.observe("repeated 8 MB downloads", {
    results,
    served: gets.map(
      (record) => `${record.protocol} ${record.status} ${record.outcome} ${record.bytes}`,
    ),
  });

  await report.check("ten large downloads all complete with the right bytes", () => {
    assert.equal(results.filter((result) => result === "ok").length, attempts, results.join(", "));
  });

  await report.check(
    "one download click survives a lost descriptor reply without fetching the file twice",
    async () => {
      const start = front.trace.length;
      front.dropReply((record) => record.operation === "files.download");
      assert.equal(await downloadRow(page, name), sha256(path));
      const traffic = front.trace.slice(start);
      assert.deepEqual(
        traffic
          .filter((record) => record.operation === "files.download")
          .map((record) => record.outcome),
        ["dropped", "complete"],
      );
      assert.equal(
        traffic.filter((record) => record.path.startsWith("/api/storage/files/")).length,
        1,
      );
    },
  );

  await context.close();
}

async function conflict(run: CoreRun) {
  const { report, front, media } = run;
  const { context, page } = await ownerPage(run);
  const target = "contested.bin";

  await uploadTarget(run, page, target, 64 * 1024);

  const mine = media.bytes("mine.bin", 70 * 1024);
  const theirs = media.bytes("theirs.bin", 90 * 1024);
  const releaseComplete = front.hold((record) => record.operation === "uploads.complete");

  await startNewVersion(page, target, mine);
  await confirmNewVersion(page);

  const tray = uploadsTray(page);

  await tray.getByText("Finishing up").waitFor({ timeout: 30_000 });

  const other = await context.newPage();

  await other.goto(page.url());
  await startNewVersion(other, target, theirs);
  await confirmNewVersion(other);
  await uploadsTray(other).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
  await other.close();

  releaseComplete();

  await report.check("a concurrent version reads as a conflict, without guessing why", async () => {
    await tray
      .getByText(/The server reported a conflict, so this new version can’t continue/)
      .waitFor({
        timeout: 30_000,
      });
  });

  await report.shot(page, "replace-conflict-desktop");

  await report.check("no Retry is offered, and cancelling says what happened", async () => {
    assert.deepEqual(
      await tray.getByRole("button", { name: `Retry upload of ${target}` }).count(),
      0,
      "retry buttons",
    );
    await tray.getByRole("button", { name: `Cancel upload of ${target}` }).click();
    await tray.getByText("Cancelled. This new version wasn’t saved.").waitFor();
    await tray.getByRole("button", { name: `Remove ${target}` }).click();
  });

  await report.check("the winner's bytes are what's stored", async () => {
    await page.reload();
    assert.deepEqual(await downloadRow(page, target), sha256(theirs), "stored digest");
  });

  await context.close();
}

async function lostReply(run: CoreRun, how: "503" | "dropped") {
  const { report, front, media } = run;
  const { context, page } = await ownerPage(run);
  const target = `lost-${how}.bin`;

  await uploadTarget(run, page, target, 64 * 1024);

  const source = join(media.directory, `lost-source-${how}.bin`);

  copyFileSync(media.bytes(`lost-seed-${how}.bin`, 80 * 1024), source);

  const isComplete = (record: { operation: string | null }) =>
    record.operation === "uploads.complete";

  if (how === "503") front.replaceReply(isComplete);
  else front.dropReply(isComplete);

  await startNewVersion(page, target, source);
  await confirmNewVersion(page);

  const tray = uploadsTray(page);

  await report.check(
    `a commit whose reply is lost (${how}) makes no claim about the file`,
    async () => {
      await tray.getByText(/Couldn’t confirm the new version\./).waitFor({ timeout: 30_000 });

      const text = await tray.innerText();

      assert.ok(!/unchanged|wasn’t saved/.test(text), `claimed an outcome: ${text}`);
    },
  );

  await report.shot(page, `replace-lost-reply-${how}`);

  await report.check(`the server really committed behind that message (${how})`, () => {
    const completes = front.records.filter(isComplete);

    assert.deepEqual(completes.at(-1)?.outcome, "dropped", "fixture outcome");
  });

  await report.check(`Retry reconciles to the committed file, once (${how})`, async () => {
    const begins = front.records.filter((record) => record.operation === "uploads.begin").length;

    await tray.getByRole("button", { name: `Retry upload of ${target}` }).click();
    await tray.getByLabel("Uploaded").waitFor({ timeout: 30_000 });
    assert.deepEqual(
      front.records.filter((record) => record.operation === "uploads.begin").length,
      begins,
      "uploads begun by retrying",
    );
    await clearTray(page);
    assert.deepEqual(await downloadRow(page, target), sha256(source), "stored digest");

    await rowMenu(page, target, "Version history…");

    const dialog = page.getByRole("dialog");

    await dialog.getByRole("button", { name: "Restore" }).first().waitFor();
    assert.deepEqual(
      await dialog.getByRole("button", { name: "Restore" }).count(),
      1,
      "earlier versions",
    );
    await dialog.getByRole("button", { name: "Close" }).click();
  });

  await context.close();
}

// On the image before the fix, this situation took 180 seconds of conflicts to clear.
const RECOVERY_BUDGET_MS = 30_000;

/** Waits for the row to finish, pressing Retry as a person would each time it's offered. */
async function recoverRow(page: Page, name: string) {
  const tray = uploadsTray(page);
  const startedAt = Date.now();
  let presses = 0;

  while (Date.now() - startedAt < RECOVERY_BUDGET_MS) {
    if ((await tray.getByLabel("Uploaded").count()) > 0) {
      return { presses, milliseconds: Date.now() - startedAt, finished: true };
    }

    const retry = tray.locator(
      `button[aria-label="Retry upload of ${name}"]:not([aria-busy="true"])`,
    );

    if ((await retry.count()) > 0) {
      await retry.click();
      presses += 1;
    }

    await page.waitForTimeout(100);
  }

  return { presses, milliseconds: Date.now() - startedAt, finished: false };
}

/**
 * The browser's connection goes away while the backend is really working on a commit or a part
 * acknowledgement, at a few different moments. Whatever the backend did, Retry has to reach one
 * correct file soon, rather than conflicts until a lease expires.
 */
async function disconnectRecovery(run: CoreRun) {
  const { report, front, media, stack } = run;
  const { context, page } = await ownerPage(run);
  const results: Observed[] = [];

  // Before a reply, Chromium may resend the request itself, and the backend must cope with that.
  // After one begins it can't, so a lost commit reaches the row, and a person's Retry decides it.
  const attempts = ["uploads.complete", "uploads.part"].flatMap((operation) =>
    [false, true].flatMap((replyStarted) =>
      [0, 5, 25].map((afterMs) => ({ operation, afterMs, replyStarted })),
    ),
  );

  for (const { operation, afterMs, replyStarted } of attempts) {
    const stage = replyStarted ? "mid-reply" : "no-reply";
    const name = `disconnect-${operation.split(".")[1]}-${stage}-${afterMs}.bin`;
    const path = media.bytes(name, 64 * 1024);

    front.resetCounters();
    front.abandonRequest((record) => record.operation === operation, afterMs, replyStarted);
    await uploadFiles(page, path);

    const recovery = await recoverRow(page, name);

    const uploadsLeft = stack.sql(
      "SELECT count(*) FROM hyori_uploads WHERE state IN ('starting','uploading','finalizing') AND lease_until IS NOT NULL",
    );

    const sent = front.records.filter(({ operation: called }) => called === operation).length;

    results.push({
      operation,
      stage,
      afterMs,
      ...recovery,
      requestsSent: sent,
      abandoned: front.records.filter(({ outcome }) => outcome === "abandoned").length,
      conflicts: front.records.filter(({ status }) => status === 409).length,
      leasedUploadsAfterward: uploadsLeft,
    });

    await report.check(`${name} recovers soon, as one correct file`, async () => {
      assert.ok(recovery.finished, `not finished after ${recovery.milliseconds}ms`);
      assert.equal(
        front.records.filter(({ operation: called }) => called === "uploads.begin").length,
        1,
        "uploads begun",
      );

      // The SDK never replays a commit itself, so this one can only have come from a person.
      if (operation === "uploads.complete" && replyStarted) {
        assert.ok(recovery.presses >= 1, "a lost commit never reached the row");
      }

      await clearTray(page);
      assert.equal(await downloadRow(page, name), sha256(path));
      assert.equal(await page.getByRole("button", { name: `Actions for ${name}` }).count(), 1);
    });

    front.clearFaults();
  }

  report.observe("recovery after a disconnect during real backend work", results);

  const target = "disconnect-version.bin";

  await uploadTarget(run, page, target, 64 * 1024);

  const source = media.bytes("disconnect-version-source.bin", 80 * 1024);

  front.resetCounters();
  front.abandonRequest((record) => record.operation === "uploads.complete", 5, true);
  await startNewVersion(page, target, source);
  await confirmNewVersion(page);

  await report.check("a new version interrupted the same way recovers, once", async () => {
    const recovery = await recoverRow(page, target);

    report.observe("new version recovery after a disconnect", recovery);
    assert.ok(recovery.finished, `not finished after ${recovery.milliseconds}ms`);
    assert.ok(recovery.presses >= 1, "a lost commit never reached the row");
    await clearTray(page);
    assert.equal(await downloadRow(page, target), sha256(source));
    await rowMenu(page, target, "Version history…");

    const history = page.getByRole("dialog");

    await history.getByRole("button", { name: "Restore" }).first().waitFor();
    assert.equal(await history.getByRole("button", { name: "Restore" }).count(), 1);
    await history.getByRole("button", { name: "Close" }).click();
  });

  front.clearFaults();
  await context.close();
}

/**
 * Many real downloads, so a cancellation can be checked against the browser's reason and the host
 * network log. `disturb` runs with each attempt, to reproduce a cause rather than wait for it. Only
 * run when named, because it's slow.
 */
export async function runDownloadSoak(run: CoreRun, attempts: number, disturb?: () => void) {
  await run.report.scenario("Download soak", async () => {
    const { context, page } = await ownerPage(run);
    const name = "soak.bin";
    const path = await uploadTarget(run, page, name, 8 * MIB + 4096);
    const results: { readonly at: number; readonly result: string }[] = [];

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      disturb?.();

      try {
        assert.equal(await downloadRow(page, name), sha256(path));
        results.push({ at: Date.now(), result: "ok" });
      } catch (error) {
        results.push({ at: Date.now(), result: String(error).slice(0, 80) });
        // A disturbed listing can leave its error state up, which isn't what's under test here.
        await page.reload();
      }
    }

    run.report.observe(
      "download soak results",
      results.filter(({ result }) => result !== "ok"),
    );
    run.report.observe("download soak attempts", attempts);
    await run.report.check("all downloads finish with their original bytes", () => {
      assert.ok(results.every(({ result }) => result === "ok"));
    });
    await context.close();
  });
}

export async function runReplacementScenarios(run: CoreRun) {
  await run.report.scenario("New version: pause, reload, reselect, resume", () =>
    pauseReloadResume(run),
  );
  await run.report.scenario("New version: server restart mid-part (baseline)", () =>
    restartMidPart(run),
  );
  await run.report.scenario("Repeated large downloads", () => repeatedDownloads(run));
  await run.report.scenario("New version: concurrent conflict", () => conflict(run));
  await run.report.scenario("New version: lost reply, 503", () => lostReply(run, "503"));
  await run.report.scenario("New version: lost reply, dropped connection", () =>
    lostReply(run, "dropped"),
  );
  await run.report.scenario("Disconnects during real commit and part work", () =>
    disconnectRecovery(run),
  );
}
