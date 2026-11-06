import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import {
  assertBundleAsset,
  assertHoldsEdit,
  barButton,
  barStatus,
  closeEditor,
  downloadRow,
  assertEarlierVersions,
  EDITOR_VIEWPORT,
  editDocument,
  framePixelsChanged,
  inBundle,
  openFromRow,
  openSharedItem,
  operationCount,
  rowIn,
  saveWithKeyboard,
  sha256Of,
  uploadDocuments,
  waitForEditor,
} from "./editor-actions.ts";
import { createEditorCases } from "./editor-probe/cases.ts";
import type { EditorApp, EditorCase, EditorCases } from "./editor-probe/cases.ts";
import { fetchInPage } from "./page-actions.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { runEditorRecoveryScenarios } from "./scenarios-editor-recovery.ts";
import { createFolder } from "./scenarios-photos.ts";
import { createLink } from "./scenarios-sharing.ts";

const ALL_APPS: readonly EditorApp[] = ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"];
const DECK_VERSION = "0.14.1-hyori-host.2";
const SIGNED_IN_MARKER = "HYORISIGNEDIN";
const PUBLIC_MARKER = "HYORIPUBLIC";

/** Below this, a difference is more likely a caret or a hover than a changed document. */
const MIN_VISIBLE_CHANGE_PIXELS = 40;

async function bundleIdentity(run: CoreRun) {
  const { report, editorBundle, stack } = run;

  if (editorBundle === null) return;

  report.observe("editor bundle", {
    manifestSha256: editorBundle.manifestSha256,
    purpose: editorBundle.purpose,
    editors: editorBundle.editors.map(({ app, version }) => `${app} ${version}`),
  });

  await report.check("the handed-over bundle is a runtime bundle", () => {
    assert.equal(editorBundle.purpose, "runtime");
  });

  for (const app of ALL_APPS) {
    if (!inBundle(run, app)) {
      report.unverified(
        `${app} is available`,
        "It isn't in this bundle, so nothing here covers it.",
      );
    }
  }

  if (inBundle(run, "deckcraft")) {
    await report.check("Deck is the rebuilt host version", () => {
      assert.equal(
        editorBundle.editors.find(({ app }) => app === "deckcraft")?.version,
        DECK_VERSION,
      );
    });
  }

  await report.check("the server activated each editor in the bundle", () => {
    const rows = stack.sql(
      "SELECT app || ' ' || version FROM hyori_editor_assets WHERE enabled ORDER BY app",
    );

    report.observe("enabled editors in the database", rows.split("\n"));

    for (const { app, version } of editorBundle.editors) {
      assert.ok(rows.split("\n").includes(`${app} ${version}`), `${app} ${version} isn't enabled`);
    }
  });
}

async function bundleServing(run: CoreRun) {
  const { report, editorBundle, origin } = run;

  if (editorBundle === null) return;

  const { context, page } = await ownerPage(run);
  const webRoot = "apps/web/public";

  for (const { app, assetUrl } of editorBundle.editors) {
    await report.check(`${app}'s entry page has the deployment contract's headers`, async () => {
      const { status, headers } = await fetchInPage(page, `${origin}${assetUrl}`);

      assert.equal(status, 200);
      assert.equal(headers["x-content-type-options"], "nosniff");
      assert.equal(headers["x-frame-options"], "SAMEORIGIN");
      assert.equal(headers["content-security-policy"], "frame-ancestors 'self'");
      assert.equal(headers["cache-control"], "no-cache");
      assert.match(headers["content-type"] ?? "", /^text\/html/);
    });
  }

  await report.check("every WebAssembly file is served as WebAssembly", async () => {
    const wasm = readdirSync(editorBundle.directory, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".wasm"))
      .map((entry) => join(entry.parentPath, entry.name).slice(editorBundle.directory.length));

    assert.ok(wasm.length > 0, "no WebAssembly in the bundle");

    for (const path of wasm) {
      const { status, headers } = await fetchInPage(page, `${origin}/artcraft${path}`);

      assert.equal(status, 200, path);
      assert.equal(headers["content-type"], "application/wasm", path);
    }
  });

  await report.check("the bundle's notices are served where the editor links to them", async () => {
    const { status, text } = await fetchInPage(
      page,
      `${origin}/artcraft/legal/RUNTIME-NOTICE-INDEX.md`,
    );

    assert.equal(status, 200);
    assert.ok(text.length > 0, "the notice index is empty");
  });

  await report.check("a missing asset is a 404, never the app's fallback page", async () => {
    assert.equal(
      (await fetchInPage(page, `${origin}/artcraft/wordcraft/not-a-version/missing.js`)).status,
      404,
    );
  });

  const deck = editorBundle.editors.find(({ app }) => app === "deckcraft");

  if (deck !== undefined) {
    const deckDirectory = join(editorBundle.directory, "deckcraft", deck.version);

    await report.check("Deck shows this product's icon, not the upstream mark", async () => {
      const { text } = await fetchInPage(page, `${origin}${deck.assetUrl}`);
      const links = text.match(/<link\b[^>]*>/g) ?? [];
      const icon = links.find((link) => /\brel=["'](?:shortcut )?icon["']/.test(link));
      const href = icon?.match(/\bhref=["']([^"']+)["']/)?.[1];

      assert.ok(href !== undefined, "Deck's page declares no icon");

      const { status, sha256 } = await fetchInPage(
        page,
        new URL(href, `${origin}${deck.assetUrl}`).href,
      );

      assert.equal(status, 200, "Deck's icon");
      assert.equal(sha256, sha256Of(readFileSync(join(webRoot, "favicon.ico"))), "Deck's icon");
    });

    await report.check("Deck's WebAssembly no longer points at the upstream sites", () => {
      const wasm = readdirSync(deckDirectory, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".wasm"),
      );

      assert.ok(wasm.length > 0, "Deck has no WebAssembly");

      for (const entry of wasm) {
        const bytes = readFileSync(join(entry.parentPath, entry.name));

        for (const mark of ["getartcraft.com", "discord.gg/artcraft"]) {
          assert.ok(!bytes.includes(mark), `${entry.name} still contains ${mark}`);
        }
      }
    });
  }

  await context.close();
}

/**
 * Reopened in a context with nothing carried over. Pixels only show the frame isn't the original
 * again, not that it shows the edit, so this leaves that open until someone has read the screenshot.
 */
async function verifyReopened(
  run: CoreRun,
  page: Page,
  item: EditorCase,
  flow: string,
  openedShot: string,
  marker: string,
) {
  const top = await waitForEditor(page, "All changes saved");

  await assertBundleAsset(run, page, item.app);

  const reopenedShot = await run.report.shot(page, `${item.app}-${flow}-reopened`);
  const changed = await framePixelsChanged(run, openedShot, reopenedShot, top);

  run.report.observe(`${item.label} ${flow} reopened frame`, {
    screenshot: reopenedShot,
    changedPixelsFromOriginal: changed,
  });
  assert.ok(
    changed >= MIN_VISIBLE_CHANGE_PIXELS,
    `only ${changed} pixels differ from the original`,
  );
  await barStatus(page, "All changes saved").waitFor();
  run.report.unverified(
    `${item.label} ${flow}: what the reopened document shows`,
    `Read ${reopenedShot}: it must show ${item.shows(marker)}.`,
  );
}

async function signedInRoundTrip(
  run: CoreRun,
  context: BrowserContext,
  folderPath: string,
  item: EditorCase,
) {
  const { report, front, origin } = run;
  const name = `signed-in-${item.app}${item.extension}`;
  const label = `${item.label}, signed in`;
  const page = await openPage(run, context, folderPath);
  let editorPath = "";
  let openedShot = "";

  const saved = await report.check(
    `${label}: opens from its row, takes a real edit, and the server confirms the save`,
    async () => {
      const top = await openFromRow(page, name);

      editorPath = new URL(page.url()).pathname;
      await assertBundleAsset(run, page, item.app);
      openedShot = await report.shot(page, `${item.app}-signed-in-opened`);
      await editDocument(page, item, top, SIGNED_IN_MARKER);
      await saveWithKeyboard(run, page);
      await closeEditor(page);
      await rowIn(page, name).waitFor();
    },
  );

  if (!saved) {
    await page.close();

    return;
  }

  await report.check(`${label}: the file's own bytes hold the edit`, async () => {
    const bytes = await downloadRow(page, name);

    assertHoldsEdit(item, bytes, SIGNED_IN_MARKER);
    report.observe(`${label} saved`, { sha256: sha256Of(bytes), bytes: bytes.length });
  });

  await report.check(`${label}: the save is exactly one new version`, async () => {
    await assertEarlierVersions(page, name, 1);
  });

  await page.close();

  await report.check(
    `${label}: a fresh session reopens clean, and differs from the original`,
    async () => {
      const { context: fresh, page: reopened } = await ownerPage(run, {
        viewport: EDITOR_VIEWPORT,
      });

      const opens = operationCount(front, "editors.open", 200);

      try {
        await reopened.goto(`${origin}${editorPath}`, { waitUntil: "domcontentloaded" });
        await verifyReopened(run, reopened, item, "signed-in", openedShot, SIGNED_IN_MARKER);
        assert.equal(
          operationCount(front, "editors.open", 200),
          opens + 1,
          "editor sessions opened",
        );
        await closeEditor(reopened);
        await rowIn(reopened, name).waitFor();
      } finally {
        await fresh.close();
      }
    },
  );
}

async function signedInRoundTrips(run: CoreRun, cases: EditorCases) {
  const items = [cases.word, cases.grid, cases.deck, cases.pdf].filter(({ app }) =>
    inBundle(run, app),
  );

  const { context, page } = await ownerPage(run, { viewport: EDITOR_VIEWPORT });

  await createFolder(page, "Editor round trips");
  await uploadDocuments(
    run,
    page,
    items.map((item) => item.copyAs(`signed-in-${item.app}`)),
  );

  const folderPath = new URL(page.url()).pathname;

  await page.close();

  for (const item of items) await signedInRoundTrip(run, context, folderPath, item);
  await context.close();
}

async function publicRoundTrip(
  run: CoreRun,
  owner: Page,
  folderPath: string,
  linkPath: string,
  item: EditorCase,
) {
  const { report } = run;
  const name = `public-${item.app}${item.extension}`;
  const label = `${item.label}, public Editor link`;
  const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });
  const visitor = await openSharedItem(run, visitorContext, linkPath);
  let editorPath = "";
  let openedShot = "";

  const saved = await report.check(
    `${label}: a visitor with no account opens, really edits and really saves`,
    async () => {
      await rowIn(visitor, name).waitFor();

      const top = await openFromRow(visitor, name);

      editorPath = new URL(visitor.url()).pathname;
      assert.ok(editorPath.startsWith(`${linkPath}/edit/`), `left the link: ${editorPath}`);
      await assertBundleAsset(run, visitor, item.app);
      openedShot = await report.shot(visitor, `${item.app}-public-opened`);
      await editDocument(visitor, item, top, PUBLIC_MARKER);
      await saveWithKeyboard(run, visitor);
      await closeEditor(visitor);
      await rowIn(visitor, name).waitFor();
      assert.equal(new URL(visitor.url()).pathname, linkPath, "where Close went");
    },
  );

  if (!saved) {
    await visitorContext.close();

    return;
  }

  await report.check(`${label}: the visitor's download holds the edit`, async () => {
    const bytes = await downloadRow(visitor, name);

    assertHoldsEdit(item, bytes, PUBLIC_MARKER);
    report.observe(`${label} saved`, { sha256: sha256Of(bytes), bytes: bytes.length });
  });

  await visitorContext.close();

  await report.check(`${label}: the owner's file has it, as one new version`, async () => {
    await owner.goto(`${run.origin}${folderPath}`, { waitUntil: "domcontentloaded" });
    await rowIn(owner, name).waitFor();
    assertHoldsEdit(item, await downloadRow(owner, name), PUBLIC_MARKER);
    await assertEarlierVersions(owner, name, 1);
  });

  await report.check(
    `${label}: a new visitor reopens it clean, and it differs from the original`,
    async () => {
      const freshVisitor = await freshContext(run, { viewport: EDITOR_VIEWPORT });

      try {
        const reopened = await openSharedItem(run, freshVisitor, editorPath);

        await verifyReopened(run, reopened, item, "public", openedShot, PUBLIC_MARKER);
        await closeEditor(reopened);
        await rowIn(reopened, name).waitFor();
      } finally {
        await freshVisitor.close();
      }
    },
  );
}

async function publicRoundTrips(run: CoreRun, cases: EditorCases) {
  const items = [cases.word, cases.grid, cases.deck, cases.pdf].filter(({ app }) =>
    inBundle(run, app),
  );

  const folder = "Editor public folder";
  const { context, page } = await ownerPage(run);

  await createFolder(page, folder);
  await uploadDocuments(
    run,
    page,
    items.map((item) => item.copyAs(`public-${item.app}`)),
  );

  const folderPath = new URL(page.url()).pathname;

  await page.getByRole("link", { name: "Files" }).first().click();
  await rowIn(page, folder).waitFor();

  const linkPath = new URL(await createLink(page, folder, "Editor")).pathname;

  for (const item of items) await publicRoundTrip(run, page, folderPath, linkPath, item);
  await context.close();
}

/** A link to one file has no row and no folder, so it has its own way in, and nowhere for a copy. */
async function singleFileLink(run: CoreRun, cases: EditorCases) {
  const { report, front } = run;
  const { context, page } = await ownerPage(run);
  const wordName = "single-link.docx";
  const pptxName = "single-link.pptx";

  await createFolder(page, "Editor single links");
  await uploadDocuments(run, page, [
    cases.word.copyAs("single-link"),
    cases.deckFromPptx.copyAs("single-link"),
  ]);

  if (inBundle(run, "wordcraft")) {
    const linkPath = new URL(await createLink(page, wordName, "Editor")).pathname;
    const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });
    const visitor = await openSharedItem(run, visitorContext, linkPath);
    let opened = "";
    let editorPath = "";

    await report.check("a one-file Editor link: opens, edits and saves", async () => {
      await visitor.getByRole("button", { name: "Open in editor" }).click();
      await visitor.waitForURL(/\/edit\/[^/]+$/);

      const top = await waitForEditor(visitor, "All changes saved");

      editorPath = new URL(visitor.url()).pathname;
      opened = await report.shot(visitor, "wordcraft-single-link-opened");
      await editDocument(visitor, cases.word, top, PUBLIC_MARKER);
      await saveWithKeyboard(run, visitor);
      await closeEditor(visitor);
      await visitor.getByRole("heading", { name: wordName }).waitFor();
    });

    await visitorContext.close();

    await report.check(
      "a one-file Editor link: a new visitor reopens it clean, and it differs",
      async () => {
        const fresh = await freshContext(run, { viewport: EDITOR_VIEWPORT });

        try {
          const reopened = await openSharedItem(run, fresh, editorPath);

          await verifyReopened(run, reopened, cases.word, "single-link", opened, PUBLIC_MARKER);
        } finally {
          await fresh.close();
        }
      },
    );
  }

  if (inBundle(run, "deckcraft")) {
    const linkPath = new URL(await createLink(page, pptxName, "Editor")).pathname;
    const visitorContext = await freshContext(run, { viewport: EDITOR_VIEWPORT });
    const visitor = await openSharedItem(run, visitorContext, linkPath);

    await report.check(
      "a one-file link has no folder for a copy: it says so, saves nothing, keeps the work",
      async () => {
        const prepares = operationCount(front, "editors.prepareSave");

        await visitor.getByRole("button", { name: "Open in editor" }).click();
        await visitor.waitForURL(/\/edit\/[^/]+$/);

        const top = await waitForEditor(visitor, "All changes saved");

        await editDocument(visitor, cases.deckFromPptx, top, PUBLIC_MARKER);
        await visitor.keyboard.press("Control+s");

        const dialog = visitor.getByRole("dialog");

        await dialog.getByText("This link only shares one file").waitFor({ timeout: 30_000 });
        await dialog.getByRole("button", { name: "Close" }).first().click();
        await barStatus(visitor, /^Not saved$/).waitFor();
        await barButton(visitor, "Download my version").waitFor();
        assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");
      },
    );
    await visitorContext.close();
  }

  await context.close();
}

/**
 * The real path through everything, for each editor in the bundle. Run only when named, because it
 * needs a verified bundle and says nothing without one. Screenshots of reopened documents are the
 * evidence: nothing else here can tell a real render from a blank one.
 */
export async function runEditorScenarios(run: CoreRun) {
  const { report, editorBundle } = run;

  if (editorBundle === null) {
    report.unverified("every editor scenario", "No editor bundle was handed to this run.");

    return;
  }

  const work = mkdtempSync(join(tmpdir(), "hyori-browser-editors-"));

  try {
    const cases = createEditorCases(work);
    // A tray showing a failure isn't a subject to capture, so setup failures report in words only.
    const quiet = { captureFailure: false };

    await report.scenario("Editor bundle identity", () => bundleIdentity(run), quiet);
    await report.scenario("Editor bundle serving", () => bundleServing(run), quiet);
    await report.scenario("Editors, signed in", () => signedInRoundTrips(run, cases), quiet);
    await report.scenario("Editors, public links", () => publicRoundTrips(run, cases), quiet);
    await report.scenario("Editors, one-file links", () => singleFileLink(run, cases), quiet);
    await runEditorRecoveryScenarios(run, cases);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
