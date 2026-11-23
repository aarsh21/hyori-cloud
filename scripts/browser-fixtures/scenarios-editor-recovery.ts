import assert from "node:assert/strict";
import type { BrowserContext, Locator, Page } from "playwright-core";
import {
  assertHoldsEdit,
  assertBundleAsset,
  barButton,
  barStatus,
  closeEditor,
  cover,
  coverButton,
  downloadRow,
  assertEarlierVersions,
  EDITOR_VIEWPORT,
  editDocument,
  inBundle,
  inNativeEditor,
  openFromRow,
  openSharedItem,
  OPENED_CLEAN,
  operationCount,
  promptRefused,
  rowIn,
  saveWithKeyboard,
  sha256Of,
  untilOperation,
  uploadDocuments,
  waitForEditor,
} from "./editor-actions.ts";
import type { EditorCase, EditorCases } from "./editor-probe/cases.ts";
import { downloadBytes, rowMenu, signIn } from "./page-actions.ts";
import { accountPassword, addUser, openUsers } from "./scenarios-admin.ts";
import { freshContext, openPage, ownerPage, waitForHydration } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { createFolder } from "./scenarios-photos.ts";
import { createLink, revokeLink } from "./scenarios-sharing.ts";

const MINE = "HYORIMINE";
const THEIRS = "HYORITHEIRS";
const RETRIED = "HYORIRETRIED";
const COPIED = "HYORICOPIED";
const LATER = "HYORILATER";

/** A conflict is off screen entirely: nothing here may capture it, including on failure. */
const NEVER_CAPTURED = { captureFailure: false };

// Playwright considers a fully transparent dialog visible. In Chromium with a composited
// editor, the initial click at its future button position can still reach the canvas.
// Wait for the real popup, then send one ordinary pointer click; never retry a save.
async function clickDialogButton(dialog: Locator, name: string) {
  const popup = await dialog.elementHandle();

  try {
    await dialog
      .page()
      .waitForFunction(
        (element) =>
          !element.hasAttribute("data-starting-style") && getComputedStyle(element).opacity === "1",
        popup,
        { timeout: 15_000 },
      );
    await dialog.getByRole("button", { name, exact: true }).click();
  } finally {
    await popup.dispose();
  }
}

async function requestNativeCopy(page: Page) {
  await barButton(page, "Save a copy").click();
  await clickDialogButton(page.getByRole("dialog", { name: "Save a copy" }), "Continue");
}

const savedRequest = (run: CoreRun, operation: string) =>
  run.front.trace
    .filter((record) => record.operation === operation)
    .map((record) => /"saveId":"([^"]+)"/.exec(record.rpcBody ?? "")?.[1]);

/**
 * How many versions this check may have made: exactly one for a legacy editor. A protocol 2
 * editor's background saves may land before and after the one under test, so it made at least
 * one and at most one per save the server confirmed since `from` in the trace. A save confirmed
 * twice (a retry finding a lost reply) is one save, and a save of unchanged bytes adds none.
 */
async function versionsMade(run: CoreRun, page: Page, from: number) {
  if (!(await inNativeEditor(run, page))) return { least: 1, most: 1 };

  const confirmed = new Set(
    run.front.trace
      .slice(from)
      .filter((record) => record.operation === "editors.completeSave" && record.status === 200)
      .map((record) => /"saveId":"([^"]+)"/.exec(record.rpcBody ?? "")?.[1]),
  );

  return { least: 1, most: confirmed.size };
}

async function assertVersionsMade(
  page: Page,
  name: string,
  { least, most }: { least: number; most: number },
) {
  const count = await assertEarlierVersions(page, name, least, "at least");

  assert.ok(count <= most, `${name} has ${count} earlier versions, more than ${most} saves made`);
}

async function folderWith(run: CoreRun, folder: string, paths: readonly string[]) {
  const { context, page } = await ownerPage(run, { viewport: EDITOR_VIEWPORT });

  await createFolder(page, folder);
  await uploadDocuments(run, page, paths);

  return { context, page, folderPath: new URL(page.url()).pathname };
}

/** Change the real backend's mounted catalogues without reloading either open editor tab. */
export async function editorRollover(
  previous: CoreRun,
  current: CoreRun,
  item: EditorCase,
  switchBundles: () => Promise<void>,
) {
  const { front, report } = current;
  const dirtyName = `rollover-dirty${item.extension}`;
  const replayName = `rollover-replay${item.extension}`;

  const {
    context,
    page: dirty,
    folderPath,
  } = await folderWith(previous, "Editor rollover", [
    item.copyAs("rollover-dirty"),
    item.copyAs("rollover-replay"),
  ]);

  const dirtyTop = await openFromRow(dirty, dirtyName);
  const replay = await openPage(previous, context, folderPath);
  const replayTop = await openFromRow(replay, replayName);
  const start = front.trace.length;

  const completions = () =>
    front.trace.slice(start).filter(({ operation }) => operation === "editors.completeSave");

  const dirtyPrepares = () =>
    front.trace
      .slice(start)
      .filter(
        ({ operation, rpcBody }) =>
          operation === "editors.prepareSave" && rpcBody?.includes(`"name":"${dirtyName}"`),
      );

  const saveId = (body: string | null) => /"saveId":"([^"]+)"/.exec(body ?? "")?.[1];

  const releaseDirty = front.hold(
    ({ operation, rpcBody }) =>
      operation === "editors.prepareSave" && rpcBody?.includes(`"name":"${dirtyName}"`) === true,
    Number.POSITIVE_INFINITY,
  );

  const releaseReplay = front.hold(({ operation, rpcBody }) => {
    const lost = completions().find(({ outcome }) => outcome === "dropped");

    return (
      lost !== undefined &&
      (operation === "editors.prepareSave" || operation === "editors.completeSave") &&
      saveId(lost.rpcBody) === saveId(rpcBody)
    );
  }, Number.POSITIVE_INFINITY);

  try {
    await assertBundleAsset(previous, dirty, item.app);
    await assertBundleAsset(previous, replay, item.app);
    await dirty.bringToFront();
    await editDocument(dirty, item, dirtyTop, MINE);
    await dirty.keyboard.press("Control+s");
    await replay.bringToFront();
    front.dropReply(({ operation }) => operation === "editors.completeSave");
    await editDocument(replay, item, replayTop, RETRIED);
    await replay.keyboard.press("Control+s");

    const deadline = Date.now() + 30_000;

    while (!completions().some(({ outcome }) => outcome === "dropped") || !dirtyPrepares().length) {
      assert.ok(Date.now() < deadline, "both old tabs must reach the cutover boundary");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }

    const lost = completions().find(({ outcome }) => outcome === "dropped");
    const replayId = saveId(lost?.rpcBody ?? null);
    assert.equal(lost?.status, 200, "the old backend committed before losing the reply");
    assert.ok(replayId, "the first committed save has an ID to replay");
    assert.ok(
      dirtyPrepares().every(({ status }) => status === 0),
      "the dirty tab has not prepared on the old backend",
    );

    await switchBundles();
    releaseDirty();
    releaseReplay();

    await report.check("dirty r5 tab prepares and saves after switching to r6", async () => {
      await barStatus(dirty, "All changes saved").waitFor({ timeout: 30_000 });
      assert.ok(dirtyPrepares().some(({ status }) => status === 200));
      await assertBundleAsset(previous, dirty, item.app);
      await closeEditor(dirty);
      assertHoldsEdit(item, await downloadRow(dirty, dirtyName), MINE);
      await assertEarlierVersions(dirty, dirtyName, 1);
    });

    await report.check(
      "an r5 save with a lost reply replays the same ID on r6 exactly once",
      async () => {
        await barStatus(replay, "All changes saved").waitFor({ timeout: 30_000 });
        assert.ok(
          completions().some(
            ({ status, outcome, rpcBody }) =>
              status === 200 && outcome === "complete" && saveId(rpcBody) === replayId,
          ),
          "the restarted backend must acknowledge the same durable save",
        );
        await assertBundleAsset(previous, replay, item.app);
        await closeEditor(replay);
        assertHoldsEdit(item, await downloadRow(replay, replayName), RETRIED);
        await assertEarlierVersions(replay, replayName, 1);
      },
    );

    await report.check(
      "an open after the switch starts r6, not the retained r5 editor",
      async () => {
        const fresh = await openPage(current, context, folderPath);
        await openFromRow(fresh, dirtyName);
        await assertBundleAsset(current, fresh, item.app);
      },
    );
  } finally {
    releaseDirty();
    releaseReplay();
    await context.close();
  }
}

async function conflict(run: CoreRun, item: EditorCase, context: BrowserContext, path: string) {
  const name = `conflict-${item.app}${item.extension}`;

  const stale = await openPage(run, context, path);
  const newer = await openPage(run, context, path);

  try {
    const staleTop = await openFromRow(stale, name);
    const newerTop = await openFromRow(newer, name);

    const traceStart = run.front.trace.length;

    await newer.bringToFront();
    await editDocument(newer, item, newerTop, THEIRS);
    await saveWithKeyboard(run, newer);

    const versions = await versionsMade(run, newer, traceStart);

    await closeEditor(newer);

    const theirs = await downloadRow(newer, name);
    assertHoldsEdit(item, theirs, THEIRS);

    // Real users switch tabs to type. In a background tab Chromium can deliver the keys
    // to the canvas before Grid opens its cell input, losing letters before any save.
    await stale.bringToFront();

    // Word keeps its caret, so it can go on typing after the refused save took its snapshot: what
    // it typed then is only in the editor, and Download my version has to hold it too.
    const typesOn = item.app === "wordcraft" && (await inNativeEditor(run, stale));
    const prepares = operationCount(run.front, "editors.prepareSave");

    const release = typesOn
      ? run.front.hold((record) => record.operation === "editors.prepareSave")
      : () => {};

    try {
      await editDocument(stale, item, staleTop, MINE);
      await stale.keyboard.press("Control+s");

      if (typesOn) {
        const deadline = Date.now() + 60_000;

        while (operationCount(run.front, "editors.prepareSave") === prepares) {
          assert.ok(Date.now() < deadline, "the save never reached the server");
          await stale.waitForTimeout(100);
        }

        await stale.keyboard.type(LATER, { delay: 60 });
        await stale.waitForTimeout(1000);
      }
    } finally {
      release();
    }

    await barStatus(stale, "Not saved: changed elsewhere").waitFor({ timeout: 90_000 });
    // The cover says what happened, and the editor under it takes no more input to lose.
    await cover(stale).getByText("This file was changed somewhere else").waitFor();
    assert.equal(
      await stale.locator('[data-slot="hosted-document-frame"]').getAttribute("inert"),
      "",
      "the covered editor is inert",
    );

    const mine = await downloadBytes(stale, () =>
      coverButton(stale, "Download my version").click(),
    );

    assertHoldsEdit(item, mine, MINE);

    if (typesOn) assertHoldsEdit(item, mine, LATER);
    assert.deepEqual(
      sha256Of(await downloadRow(newer, name)),
      sha256Of(theirs),
      "the file after the refused save",
    );
    await assertVersionsMade(newer, name, versions);

    // Reopening leaves this version behind, so it asks first even after a download.
    await coverButton(stale, "Open latest version").click();

    const confirmation = stale.getByRole("alertdialog", { name: "Leave your version behind?" });

    await clickDialogButton(confirmation, "Reopen without it");
    await waitForEditor(stale, "All changes saved");
    assert.deepEqual(
      sha256Of(await downloadRow(newer, name)),
      sha256Of(theirs),
      "the file after opening the latest",
    );
  } finally {
    // Closed here, so a later failure elsewhere can't photograph what's left on screen.
    await stale.close();
    await newer.close();
  }
}

async function saveFailureRetried(run: CoreRun, item: EditorCase, page: Page, path: string) {
  const { front } = run;
  const name = `retry-${item.app}${item.extension}`;

  await page.goto(`${run.origin}${path}`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);

  const top = await openFromRow(page, name);
  const traceStart = front.trace.length;

  const prepares = savedRequest(run, "editors.prepareSave").length;
  const refused = operationCount(front, "editors.prepareSave", 503);
  const completed = operationCount(front, "editors.completeSave", 200);
  const native = await inNativeEditor(run, page);
  // The native host retries a transient refusal three times. Keep the refusal in place for
  // those attempts so this case always reaches manual recovery, even in slow Chromium runs.
  const refusals = native ? 4 : 1;

  front.refuse((record) => record.operation === "editors.prepareSave", 503, refusals);
  await editDocument(page, item, top, RETRIED);
  await page.keyboard.press("Control+s");
  await untilOperation(front, "editors.prepareSave", refused + refusals, 503);
  await barStatus(page, /^Not saved$/).waitFor({ timeout: 60_000 });
  await barButton(page, "Download my version").waitFor();
  assert.equal(operationCount(front, "editors.completeSave", 200), completed, "completed saves");

  await barButton(page, "Retry save").click();
  await untilOperation(front, "editors.completeSave", completed + 1);
  await barStatus(page, "All changes saved").waitFor({ timeout: 20_000 });

  const attempts = savedRequest(run, "editors.prepareSave").slice(prepares);

  // Later edits can save under a new ID. Only the failed save and its retries must keep theirs.
  assert.ok(attempts[0], "the failed save had no ID");
  assert.equal(attempts.slice(0, refusals + 1).length, refusals + 1, "missing retry");
  assert.ok(
    attempts.slice(0, refusals + 1).every((id) => id === attempts[0]),
    "retry changed save ID",
  );

  const versions = await versionsMade(run, page, traceStart);

  await closeEditor(page);
  assertHoldsEdit(item, await downloadRow(page, name), RETRIED);
  await assertVersionsMade(page, name, versions);
}

/** The commit may land while its reply is lost. Retrying has to find it, not make another. */
async function lostReplyRetried(run: CoreRun, item: EditorCase, page: Page, path: string) {
  const { front, report } = run;
  const name = `lost-reply-${item.app}${item.extension}`;

  await page.goto(`${run.origin}${path}`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);

  const top = await openFromRow(page, name);
  const traceStart = front.trace.length;

  const completed = operationCount(front, "editors.completeSave", 200);
  const native = await inNativeEditor(run, page);

  // The server commits before the proxy drops the reply body. The native host should recover
  // automatically, so a temporary Retry button is not required to be clickable.
  front.dropReply((record) => record.operation === "editors.completeSave");
  await editDocument(page, item, top, RETRIED);
  await page.keyboard.press("Control+s");

  if (!native) {
    await barStatus(page, /^Not saved$/).waitFor({ timeout: 60_000 });
    await barButton(page, "Retry save").click();
  }

  await untilOperation(front, "editors.completeSave", completed + 2);
  await barStatus(page, "All changes saved").waitFor({ timeout: 20_000 });

  const attempts = front.trace
    .slice(traceStart)
    .filter((record) => record.operation === "editors.completeSave" && record.status === 200);

  assert.equal(attempts[0]?.outcome, "dropped", "the first committed reply was not dropped");
  const id = (body: string | null) => /"saveId":"([^"]+)"/.exec(body ?? "")?.[1];
  const saved = id(attempts[0]?.rpcBody ?? null);
  assert.ok(saved, "the committed save had no ID");
  assert.equal(id(attempts[1]?.rpcBody ?? null), saved, "the replay changed save ID");
  report.observe(
    `${item.label} completeSave attempts after a lost reply`,
    attempts.map((record) => record.outcome),
  );

  const versions = await versionsMade(run, page, traceStart);

  await closeEditor(page);
  assertHoldsEdit(item, await downloadRow(page, name), RETRIED);
  await assertVersionsMade(page, name, versions);
}

async function recoveryForEveryEditor(run: CoreRun, cases: EditorCases) {
  const { report } = run;

  const items = [cases.word, cases.grid, cases.deck, cases.pdf].filter(({ app }) =>
    inBundle(run, app),
  );

  const { context, page, folderPath } = await folderWith(
    run,
    "Editor recovery",
    items.flatMap((item) => [
      item.copyAs(`conflict-${item.app}`),
      item.copyAs(`retry-${item.app}`),
      item.copyAs(`lost-reply-${item.app}`),
    ]),
  );

  for (const item of items) {
    await report.check(
      `${item.label}: a refused save stays as bytes to retry, and retrying saves it once`,
      () => saveFailureRetried(run, item, page, folderPath),
    );
    await report.check(
      `${item.label}: a save whose reply is lost is found again by retrying, as one version`,
      () => lostReplyRetried(run, item, page, folderPath),
    );
    await report.check(
      `${item.label}: a newer save isn't overwritten, and my version can be downloaded`,
      () => conflict(run, item, context, folderPath),
      NEVER_CAPTURED,
    );
  }

  await context.close();
}

async function unsavedWorkIsProtected(run: CoreRun, cases: EditorCases) {
  if (!inBundle(run, "wordcraft")) return;

  const { front } = run;
  const name = "no-loss.docx";

  const { context, page, folderPath } = await folderWith(run, "Editor no loss", [
    cases.word.copyAs("no-loss"),
  ]);

  const top = await openFromRow(page, name);
  // A protocol 2 editor saves on its own, so its work stays unsaved only while saves are refused.
  const native = await inNativeEditor(run, page);
  const unsaved = native ? /^Not saved$/ : "Unsaved changes";

  if (native) front.refuse((record) => record.operation === "editors.prepareSave", 503, Infinity);

  try {
    await unsavedWorkChecks(run, page, folderPath, name, top, unsaved, cases);
  } finally {
    front.clearFaults();
  }

  await context.close();
}

async function unsavedWorkChecks(
  run: CoreRun,
  page: Page,
  folderPath: string,
  name: string,
  top: number,
  unsaved: RegExp | string,
  cases: EditorCases,
) {
  const { report, front } = run;

  await editDocument(page, cases.word, top, MINE);

  const closesBeforeLeaving = operationCount(front, "editors.close");

  await report.check("Close asks first, and Keep editing keeps the work", async () => {
    await barButton(page, "Close").click();

    const confirmation = page.getByRole("alertdialog");

    await clickDialogButton(confirmation, "Keep editing");
    await confirmation.waitFor({ state: "detached" });
    await barStatus(page, unsaved).waitFor();
  });

  await report.check("Back asks first, and refusing stays in the document", async () => {
    assert.equal(await promptRefused(page, () => page.evaluate(() => history.back())), "confirm");
    await page.waitForTimeout(500);
    assert.match(new URL(page.url()).pathname, /\/edit\//);
    await barStatus(page, unsaved).waitFor();
  });

  await report.check("refusing to leave keeps the session open on the server", () => {
    assert.equal(operationCount(front, "editors.close"), closesBeforeLeaving, "sessions closed");
  });

  await report.check("closing the tab asks first", async () => {
    assert.equal(
      await promptRefused(page, () => page.close({ runBeforeUnload: true })),
      "beforeunload",
    );
    await barStatus(page, unsaved).waitFor();
  });

  await report.check("refusing to close the tab keeps the session open too", () => {
    assert.equal(operationCount(front, "editors.close"), closesBeforeLeaving, "sessions closed");
  });

  await report.check("discarding really discards, and the file is untouched", async () => {
    const completed = operationCount(front, "editors.completeSave");

    await barButton(page, "Close").click();
    await clickDialogButton(page.getByRole("alertdialog"), "Discard changes");
    await rowIn(page, name).waitFor();
    assert.equal(new URL(page.url()).pathname, folderPath, "where Close went");
    assert.equal(operationCount(front, "editors.completeSave"), completed, "saves");
    await assertEarlierVersions(page, name, 0);
    assert.equal(operationCount(front, "editors.close", 200), closesBeforeLeaving + 1, "closed");
  });

  await report.check("reloading a clean document ends its session on the way out", async () => {
    const closes = operationCount(front, "editors.close", 200);

    await openFromRow(page, name);
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitForEditor(page, "All changes saved");
    await untilOperation(front, "editors.close", closes + 1);
  });
}

/** An explicit choice of folder, and cancelling one, on a source that can't be replaced in place. */
async function deckCopyFromPptx(run: CoreRun, cases: EditorCases) {
  if (!inBundle(run, "deckcraft")) return;

  const { report, front } = run;
  const item = cases.deckFromPptx;
  const name = "copy-source.pptx";

  const { context, page } = await ownerPage(run, { viewport: EDITOR_VIEWPORT });
  const copies = "Editor copies";

  await createFolder(page, copies);

  const copiesPath = new URL(page.url()).pathname;

  await page.getByRole("link", { name: "Files" }).first().click();
  await page.getByRole("link", { name: new RegExp(`^${copies}`) }).waitFor();
  await createFolder(page, "Editor sources");
  await uploadDocuments(run, page, [item.copyAs("copy-source")]);

  const sourcePath = new URL(page.url()).pathname;
  const original = sha256Of(await downloadRow(page, name));
  let copyName = "";

  const native =
    run.editorBundle?.editors.some(({ app, protocol }) => app === "deckcraft" && protocol === 3) ===
    true;

  // A protocol 2 editor knows a PPTX is copy-only when it opens, and offers the copy itself;
  // a legacy one finds out on the first save, which then fails over to asking. Either way a
  // cancelled destination leaves the work unsaved, to retry.
  await report.check("a PPTX's first save asks where the native copy goes", async () => {
    const top = await openFromRow(
      page,
      name,
      native ? "Save a copy to keep changes" : "All changes saved",
    );

    if (native) {
      await item.edit(page, top, COPIED);
      await requestNativeCopy(page);
    } else {
      await editDocument(page, item, top, COPIED);
      await page.keyboard.press("Control+s");
    }

    await page.getByRole("heading", { name: /^Save “.*” to…$/ }).waitFor({ timeout: 30_000 });
  });

  // A protocol 2 editor treats a cancelled copy as a decision, not a failure: it goes back to
  // editing with the work still in it, and Save a copy is there to try again. A legacy one keeps
  // the cancelled copy as a failed save to retry.
  await report.check("cancelling saves nothing and keeps the work to retry", async () => {
    const prepares = operationCount(front, "editors.prepareSave");
    // The previous copy prompt may still be exiting. Include hidden content so this waits for
    // the destination to actually unmount, rather than just disappearing from accessibility.
    const destination = page.getByRole("dialog", { name: /^Save “.*” to…$/, includeHidden: true });

    await clickDialogButton(destination, "Cancel");

    if (native) {
      await destination.waitFor({ state: "detached" });
      await barStatus(page, "Save a copy to keep changes").waitFor();
      assert.ok(await barButton(page, "Save a copy").isEnabled(), "Save a copy is offered again");
    } else await barStatus(page, /^Not saved$/).waitFor();

    assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
  });

  await report.check("retrying asks again, and the copy goes where it was told", async () => {
    const completed = operationCount(front, "editors.completeSave", 200);

    if (native) {
      await requestNativeCopy(page);
      await page.getByRole("heading", { name: /^Save “.*” to…$/ }).waitFor({ timeout: 30_000 });
    } else await barButton(page, "Retry save").click();

    const dialog = page.getByRole("dialog");

    await clickDialogButton(dialog, copies);
    await dialog.getByText(copies).first().waitFor();
    await dialog.getByRole("button", { name: "Save here" }).click();
    await dialog.waitFor({ state: "detached" });
    await untilOperation(front, "editors.completeSave", completed + 1);

    if (!native) await barStatus(page, "All changes saved").waitFor({ timeout: 90_000 });
    assert.equal(
      operationCount(front, "editors.completeSave", 200),
      completed + 1,
      "completed saves",
    );

    const prepared = front.trace.findLast((record) => record.operation === "editors.prepareSave");

    copyName = /"name":"([^"]+)"/.exec(prepared?.rpcBody ?? "")?.[1] ?? "";
    assert.match(copyName, /\.deckcraft$/, "the copy's name");
  });

  if (native) {
    await report.check("a second PPTX copy asks again before writing anywhere", async () => {
      const prepares = operationCount(front, "editors.prepareSave");

      await requestNativeCopy(page);
      const destination = page.getByRole("dialog", { name: /^Save “.*” to…$/ });
      await clickDialogButton(destination, "Cancel");
      await destination.waitFor({ state: "detached" });
      await barStatus(page, "Save a copy to keep changes").waitFor();
      assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
    });
  } else {
    report.unverified("repeat PPTX saves", "The legacy editor's repeat-save flow was not tested.");
  }

  await report.check("the PPTX is untouched, with no new version", async () => {
    if (native) {
      // A copy doesn't make the original clean: its edits live in the copy, so closing asks.
      await barButton(page, "Close").click();
      await clickDialogButton(page.getByRole("alertdialog"), "Discard changes");
      await page.locator('[data-slot="hosted-document"]').waitFor({ state: "detached" });
    } else await closeEditor(page);

    await rowIn(page, name).waitFor();
    assert.equal(new URL(page.url()).pathname, sourcePath, "where Close went");
    assert.equal(sha256Of(await downloadRow(page, name)), original, "the PPTX's bytes");
    await assertEarlierVersions(page, name, 0);
  });

  await report.check("the native copy holds the edit, and reopens clean", async () => {
    assert.notEqual(copyName, "", "no copy was recorded");
    await page.goto(`${run.origin}${copiesPath}`, { waitUntil: "domcontentloaded" });
    assertHoldsEdit(item, await downloadRow(page, copyName), COPIED);

    await openFromRow(page, copyName);

    const shot = await report.shot(page, "deckcraft-pptx-copy-reopened");

    report.unverified(
      "Deck's copy of a PPTX: what the reopened document shows",
      `Read ${shot}: it must show ${item.shows(COPIED)}.`,
    );
    await closeEditor(page);
  });

  await context.close();
}

type Member = { readonly context: BrowserContext; readonly page: Page; readonly email: string };

/** A real second account, created by the admin, that the owner finds by searching their email. */
async function createMember(run: CoreRun, label: string) {
  const { context: adminContext, page: admin } = await ownerPage(run);
  const name = `${label} Reader`;
  const email = `${label.toLowerCase()}-reader@example.test`;
  const password = accountPassword();

  await openUsers(admin);
  await addUser(admin, name, email, password);
  await adminContext.close();

  const context = await freshContext(run, { viewport: EDITOR_VIEWPORT });
  const page = await openPage(run, context);

  await signIn(page, email, password);
  await page.getByText("No files yet").waitFor();

  return { context, page, email } satisfies Member;
}

async function shareWith(page: Page, item: string, email: string, role: "Viewer" | "Editor") {
  await rowMenu(page, item, "Share…");

  const dialog = page.getByRole("dialog");

  if (role === "Editor") {
    await dialog.getByRole("combobox", { name: "Role for this person" }).click();
    await page.getByRole("option", { name: /^Editor/ }).click();
  }

  await dialog.getByRole("combobox", { name: "Add people by name or email" }).fill(email);
  // The suggestion popup renders through a portal, outside the dialog's DOM.
  await page.getByRole("option", { name: new RegExp(email) }).click();
  await dialog.getByRole("button", { name: "Remove", exact: true }).waitFor();
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "detached" });
}

async function stopSharing(page: Page, item: string) {
  await rowMenu(page, item, "Share…");

  const dialog = page.getByRole("dialog");

  await dialog.getByRole("button", { name: "Remove" }).click();
  await dialog.getByRole("button", { name: "Remove" }).waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "detached" });
}

async function openSharedRow(
  page: Page,
  name: string,
  expected: "All changes saved" | "Read only",
) {
  await page.getByRole("link", { name: "Shared" }).first().click();
  await rowIn(page, name).waitFor();

  return openFromRow(page, name, expected);
}

/**
 * Word's Save As lives in its own menus and has been declined as a screenshot subject, so this goes
 * by what's in the page and on the wire, and captures nothing. Word draws to a canvas, so the control
 * may not be findable at all: that's unverified, never a pass.
 */
async function wordSaveAsControl(page: Page, top: number) {
  const browse = page
    .frameLocator('[data-slot="hosted-document-frame"]')
    .getByText("Browse…", { exact: true });

  await page.mouse.click(27, top + 53);
  await page.waitForTimeout(1500);
  await page.mouse.click(78, top + 333);
  await page.waitForTimeout(1500);

  return (await browse.count()) === 0 ? null : browse.first();
}

async function wordSaveAsCopy(run: CoreRun, page: Page, legacyBrowse: Locator | null) {
  const { front } = run;
  const completed = operationCount(front, "editors.completeSave", 200);

  if (legacyBrowse === null) await requestNativeCopy(page);
  else await legacyBrowse.click();

  const dialog = page.getByRole("dialog");

  await dialog.getByRole("heading", { name: /^Save “.*” to…$/ }).waitFor({ timeout: 30_000 });
  await clickDialogButton(dialog, "Save here");
  await untilOperation(front, "editors.completeSave", completed + 1);

  const prepared = front.trace.findLast((record) => record.operation === "editors.prepareSave");

  assert.match(prepared?.rpcBody ?? "", /"intent":"save-as"/, "what Word's Save As asked for");

  const copyName = /"name":"([^"]+)"/.exec(prepared?.rpcBody ?? "")?.[1];
  assert.ok(copyName, "Word's Save As must name the file the viewer will download");

  return copyName;
}

const READ_ONLY_FILES = [
  "read-only.docx",
  "read-only.xlsx",
  "read-only.pdf",
  "read-only.deckcraft",
  "read-only.pptx",
];

async function readOnly(run: CoreRun, cases: EditorCases) {
  const { report, front } = run;
  const member = await createMember(run, "Viewer");

  const { context, page, folderPath } = await folderWith(run, "Editor read only", [
    cases.word.copyAs("read-only"),
    cases.grid.copyAs("read-only"),
    cases.pdf.copyAs("read-only"),
    cases.deck.copyAs("read-only"),
    cases.deckFromPptx.copyAs("read-only"),
  ]);

  await page.goto(`${run.origin}${folderPath}`, { waitUntil: "domcontentloaded" });

  for (const name of READ_ONLY_FILES) {
    await shareWith(page, name, member.email, "Viewer");
  }

  const unchanged = new Map<string, string>();

  for (const name of READ_ONLY_FILES) {
    unchanged.set(name, sha256Of(await downloadRow(page, name)));
  }

  const reader = member.page;
  let wordCopy: string | null = null;

  if (inBundle(run, "wordcraft")) {
    let top = 0;

    await report.check(
      "a viewer's Word: opens read only, and saving replaces nothing",
      async () => {
        top = await openSharedRow(reader, "read-only.docx", "Read only");

        const prepares = operationCount(front, "editors.prepareSave");

        await cases.word.edit(reader, top, MINE);
        await reader.keyboard.press("Control+s");
        await reader.waitForTimeout(3000);
        assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
        await barStatus(reader, "Read only").waitFor();
      },
    );

    const native = await inNativeEditor(run, reader);
    const browse = native ? null : await wordSaveAsControl(reader, top).catch(() => null);

    if (!native && browse === null) {
      report.unverified(
        "a read-only Word document's Save As makes a copy",
        "No Browse… control could be found in the editor without looking at it.",
      );
    } else {
      await report.check(
        "a viewer's Word: Save As makes a copy, by traffic alone",
        async () => {
          wordCopy = await wordSaveAsCopy(run, reader, browse);
        },
        NEVER_CAPTURED,
      );
    }

    // Closed rather than navigated, so nothing from that menu is left to be captured later.
    await reader.close();
  }

  for (const [item, name] of [
    [cases.grid, "read-only.xlsx"],
    [cases.pdf, "read-only.pdf"],
  ] as const) {
    if (!inBundle(run, item.app)) continue;

    await report.check(
      `a viewer's ${item.label}: opens read only, and saving replaces nothing`,
      async () => {
        const page = await openPage(run, member.context);

        try {
          const top = await openSharedRow(page, name, "Read only");
          const prepares = operationCount(front, "editors.prepareSave");

          await item.edit(page, top, MINE);
          await page.keyboard.press("Control+s");
          await page.waitForTimeout(3000);
          assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
          await barStatus(page, "Read only").waitFor();
        } finally {
          await page.close();
        }
      },
    );
  }

  const secondReader = await openPage(run, member.context);

  if (wordCopy !== null) {
    const copy = wordCopy;

    await report.check("a viewer's Word: the copy is in their files, with the edit", async () => {
      assertHoldsEdit(cases.word, await downloadRow(secondReader, copy), MINE);
    });
  }

  if (inBundle(run, "deckcraft")) {
    await report.check("a viewer's Deck: a native file saves nothing in place", async () => {
      const top = await openSharedRow(secondReader, "read-only.deckcraft", "Read only");
      const prepares = operationCount(front, "editors.prepareSave");

      await cases.deck.edit(secondReader, top, MINE);
      await secondReader.keyboard.press("Control+s");
      await secondReader.waitForTimeout(3000);
      assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
    });

    await secondReader.goto(`${run.origin}/`, { waitUntil: "domcontentloaded" });

    await report.check("a viewer's Deck: a PPTX's copy goes in their own files", async () => {
      const completed = operationCount(front, "editors.completeSave", 200);
      const top = await openSharedRow(secondReader, "read-only.pptx", "Read only");

      await cases.deckFromPptx.edit(secondReader, top, COPIED);

      // A protocol 2 editor offers the copy itself; a legacy one asks on Ctrl+S.
      if (await inNativeEditor(run, secondReader)) await requestNativeCopy(secondReader);
      else await secondReader.keyboard.press("Control+s");

      const dialog = secondReader.getByRole("dialog");

      await dialog.getByRole("heading", { name: /^Save “.*” to…$/ }).waitFor({ timeout: 30_000 });
      await clickDialogButton(dialog, "Save here");
      await untilOperation(front, "editors.completeSave", completed + 1);
      await dialog.waitFor({ state: "detached" });

      const prepared = front.trace.findLast((record) => record.operation === "editors.prepareSave");

      const copy = /"name":"([^"]+)"/.exec(prepared?.rpcBody ?? "")?.[1] ?? "";

      assert.match(copy, /\.deckcraft$/, "the copy's name");
      await barStatus(secondReader, "Read only").waitFor();
      await secondReader.goto(`${run.origin}/`, { waitUntil: "domcontentloaded" });
      assertHoldsEdit(cases.deckFromPptx, await downloadRow(secondReader, copy), COPIED);
    });
  }

  await report.check("nothing a viewer did reached the owner's files", async () => {
    await page.goto(`${run.origin}${folderPath}`, { waitUntil: "domcontentloaded" });

    for (const [name, digest] of unchanged) {
      assert.equal(sha256Of(await downloadRow(page, name)), digest, name);
      await assertEarlierVersions(page, name, 0);
    }
  });

  await member.context.close();
  await context.close();
}

async function accessEnds(run: CoreRun, cases: EditorCases) {
  if (!inBundle(run, "wordcraft")) return;

  const { report } = run;
  const member = await createMember(run, "Editor");

  const { context, page } = await folderWith(run, "Editor access ends", [
    cases.word.copyAs("access-account"),
    cases.word.copyAs("access-link"),
  ]);

  const accountFile = "access-account.docx";

  await shareWith(page, accountFile, member.email, "Editor");

  const original = sha256Of(await downloadRow(page, accountFile));

  await report.check("losing access mid-edit stops saving, and hands back the work", async () => {
    const top = await openSharedRow(member.page, accountFile, "All changes saved");

    // The next save is held until access has ended: a protocol 2 editor starts its own save
    // as soon as there's an edit, and that save, like Ctrl+S's, has to arrive too late.
    const release = run.front.hold((record) => record.operation === "editors.prepareSave");

    try {
      await editDocument(member.page, cases.word, top, MINE);
      await stopSharing(page, accountFile);
      await member.page.keyboard.press("Control+s");
    } finally {
      release();
    }

    await member.page
      .getByText("You no longer have access to this file")
      .waitFor({ timeout: 60_000 });
    await barStatus(member.page, "Access ended").waitFor();

    const work = await downloadBytes(member.page, () =>
      member.page.locator("main").getByRole("button", { name: "Download my version" }).click(),
    );

    assertHoldsEdit(cases.word, work, MINE);
    assert.equal(sha256Of(await downloadRow(page, accountFile)), original, "the owner's file");
  });

  const linkFile = "access-link.docx";
  const linkPath = new URL(await createLink(page, linkFile, "Editor")).pathname;

  const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });
  const visitor = await openSharedItem(run, visitorContext, linkPath);

  await report.check("a revoked link stops saving, and hands back the work", async () => {
    await visitor.getByRole("button", { name: "Open in editor" }).click();
    await visitor.waitForURL(/\/edit\/[^/]+$/);

    const top = await waitForEditor(visitor, "All changes saved");
    const before = sha256Of(await downloadRow(page, linkFile));

    const traceStart = run.front.trace.length;
    const release = run.front.hold((record) => record.operation === "editors.prepareSave");

    try {
      await editDocument(visitor, cases.word, top, MINE);
      await revokeLink(page, linkFile);
      await visitor.keyboard.press("Control+s");
    } finally {
      release();
    }

    await barStatus(visitor, /^(Access ended|Session ended)$/).waitFor({ timeout: 60_000 });

    const attempts = run.front.trace
      .slice(traceStart)
      .filter((r) => r.operation === "editors.prepareSave");

    assert.ok(
      attempts.length > 0 && attempts.every((r) => r.status === 403 || r.status === 404),
      "every save must reach the server and be refused after revocation",
    );
    // Maintenance removes dead link sessions. The server then reports a missing session (404),
    // not a live session whose access was revoked (403). Both must offer local recovery.
    const missing = attempts[0]?.status === 404;
    await barStatus(visitor, missing ? "Session ended" : "Access ended").waitFor();
    await cover(visitor)
      .getByText(
        missing ? "This editing session has ended" : "You no longer have access to this file",
        { exact: true },
      )
      .waitFor();

    const work = await downloadBytes(visitor, () =>
      visitor.locator("main").getByRole("button", { name: "Download my version" }).click(),
    );

    assertHoldsEdit(cases.word, work, MINE);
    assert.equal(sha256Of(await downloadRow(page, linkFile)), before, "the owner's file");
    await assertEarlierVersions(page, linkFile, 0);
  });

  await visitorContext.close();
  await member.context.close();
  await context.close();
}

async function viewerLink(run: CoreRun, cases: EditorCases) {
  if (!inBundle(run, "wordcraft")) return;

  const { report, front } = run;

  const { context, page } = await folderWith(run, "Editor viewer link", [
    cases.word.copyAs("viewer-link"),
  ]);

  const linkPath = new URL(await createLink(page, "viewer-link.docx", "Viewer")).pathname;
  const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });
  const visitor = await openSharedItem(run, visitorContext, linkPath);

  await report.check("a public Viewer link opens read only and saves nothing", async () => {
    await visitor.getByRole("button", { name: "Open in editor" }).click();
    await visitor.waitForURL(/\/edit\/[^/]+$/);

    const top = await waitForEditor(visitor, "Read only");
    const prepares = operationCount(front, "editors.prepareSave");

    await cases.word.edit(visitor, top, MINE);
    await visitor.keyboard.press("Control+s");
    await visitor.waitForTimeout(3000);
    assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
    await assertEarlierVersions(page, "viewer-link.docx", 0);
  });

  await visitorContext.close();
  await context.close();
}

/**
 * Closing an editor releases nothing, so ordinary use can run into the limit on open sessions: 32 per
 * person, for 24 hours, by this point in a run. This fails for as long as that can block someone.
 */
async function sessionLimit(run: CoreRun, cases: EditorCases) {
  const { report, stack, front } = run;
  const name = "session-limit.docx";

  const { context, page } = await folderWith(run, "Editor session limit", [
    cases.word.copyAs("session-limit"),
  ]);

  report.observe(
    "most editor sessions held by one person, none of them open now",
    Number(
      stack.sql(
        "SELECT count(*) FROM hyori_editor_sessions WHERE expires_at>now() GROUP BY owner_id,principal ORDER BY 1 DESC LIMIT 1",
      ),
    ),
  );

  await report.check(
    "someone who has closed their earlier documents can open another",
    async () => {
      await rowMenu(page, name, "Open in editor");
      await page
        .locator('[data-slot="hosted-document"] header [role="status"]', {
          hasText: /^(All changes saved|Ready to edit|Editor stopped)$/,
        })
        .waitFor({ timeout: 180_000 });

      const refused = front.trace.findLast((record) => record.operation === "editors.open");

      report.observe("that open's reply", `${refused?.status} ${refused?.errorBody ?? ""}`);
      await barStatus(page, OPENED_CLEAN).waitFor({ timeout: 1000 });
    },
  );

  await context.close();
}

/** Closes a page, then waits until the gateway has answered every API request since `since`. */
async function closeAndSettle(page: Page, front: CoreRun["front"], since: number) {
  await page.close();

  for (const deadline = Date.now() + 30_000; ;) {
    const inFlight = front.trace.filter(
      ({ at, path, outcome }) => at >= since && path.startsWith("/api/") && outcome === "pending",
    );

    if (inFlight.length === 0) return;

    if (Date.now() > deadline)
      throw new Error(`Still in flight: ${inFlight.map(({ path }) => path).join(", ")}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** One editor off, by the same row an operator would change. Restored whatever happens here. */
async function killSwitch(run: CoreRun, cases: EditorCases) {
  if (!inBundle(run, "gridcraft")) return;

  const { report, stack, front } = run;
  const name = "kill-switch.xlsx";

  const { context, page, folderPath } = await folderWith(run, "Editor kill switch", [
    cases.grid.copyAs("kill-switch"),
  ]);

  const setEnabled = (enabled: boolean) =>
    stack.sql(`UPDATE hyori_editor_assets SET enabled=${enabled} WHERE app='gridcraft'`);

  const top = await openFromRow(page, name);
  const editorPath = new URL(page.url()).pathname;

  await editDocument(page, cases.grid, top, MINE);

  const completed = operationCount(front, "editors.completeSave", 200);
  const switchedOff = Date.now();

  try {
    setEnabled(false);

    await report.check("switching an editor off stops a session already open", async () => {
      await page.keyboard.press("Control+s");
      await barStatus(page, /^(Not saved|Access ended|Editor stopped)$/).waitFor({
        timeout: 60_000,
      });
      report.observe(
        "what an open session says when its editor is off",
        await barStatus(page, /./).innerText(),
      );
      assert.equal(
        operationCount(front, "editors.completeSave", 200),
        completed,
        "completed saves",
      );
    });

    const { context: fresh, page: other } = await ownerPage(run, { viewport: EDITOR_VIEWPORT });

    await report.check(
      "a switched-off editor isn't offered, or opened from a saved link",
      async () => {
        await other.goto(`${run.origin}${folderPath}`, { waitUntil: "domcontentloaded" });
        await other.getByRole("button", { name: `Actions for ${name}` }).click();
        await other.getByRole("menuitem", { name: "Download" }).waitFor();
        assert.equal(
          await other.getByRole("menuitem", { name: "Open in editor" }).count(),
          0,
          "Open in editor entries",
        );
        await other.keyboard.press("Escape");
        await other.goto(`${run.origin}${editorPath}`, { waitUntil: "domcontentloaded" });
        // It says which of the ways an open can fail this was, and changes nothing.
        await cover(other).getByText("Editing isn’t available right now").waitFor({
          timeout: 60_000,
        });
        await cover(other).getByText("The editor is turned off on this server").waitFor();
        await cover(other).getByText("Your file hasn’t changed.").waitFor();
        await barStatus(other, "Editor stopped").waitFor();
      },
    );

    await fresh.close();
  } finally {
    // The open session's refused save is retryable: it replays the same snapshot a bounded number
    // of times, and a replay after the editor is back saves the edit, as intended. That isn't what
    // the next check is about, so the session closes and every request it sent is answered while
    // the editor is still off. Then nothing of it can reach the server once it's back on.
    await closeAndSettle(page, front, switchedOff).finally(() => setEnabled(true));
  }

  // Through someone else: the owner may have reached their own session limit by now, checked next.
  await report.check("switching it back on restores it, with the file untouched", async () => {
    const { context: fresh, page: other } = await ownerPage(run, { viewport: EDITOR_VIEWPORT });
    const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });

    try {
      await other.goto(`${run.origin}${folderPath}`, { waitUntil: "domcontentloaded" });

      const linkPath = new URL(await createLink(other, name, "Editor")).pathname;
      const visitor = await openSharedItem(run, visitorContext, linkPath);

      await visitor.getByRole("button", { name: "Open in editor" }).click();
      await visitor.waitForURL(/\/edit\/[^/]+$/);
      await waitForEditor(visitor, "All changes saved");
      await rowIn(other, name).waitFor();
      await assertEarlierVersions(other, name, 0);
    } finally {
      await visitorContext.close();
      await fresh.close();
    }
  });

  await sessionLimit(run, cases);

  await context.close();
}

export async function runEditorRecoveryScenarios(run: CoreRun, cases: EditorCases) {
  const { report } = run;
  const quiet = { captureFailure: false };

  await report.scenario("Editor recovery", () => recoveryForEveryEditor(run, cases), quiet);
  await report.scenario("Editor unsaved work", () => unsavedWorkIsProtected(run, cases), quiet);
  await report.scenario("Editor copies from PPTX", () => deckCopyFromPptx(run, cases), quiet);
  await report.scenario("Editor read-only access", () => readOnly(run, cases), quiet);
  await report.scenario("Editor access ending", () => accessEnds(run, cases), quiet);
  await report.scenario("Editor Viewer links", () => viewerLink(run, cases), quiet);
  await report.scenario("Editor switched off", () => killSwitch(run, cases), quiet);
}
