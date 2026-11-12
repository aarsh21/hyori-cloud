import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright-core";
import { z } from "zod";
import { editorContentSecurityPolicy } from "../editor-csp.ts";
import {
  assertBundleAsset,
  assertHoldsEdit,
  barButton,
  barStatus,
  closeEditor,
  downloadRow,
  OPENED_CLEAN,
  untilEditorChrome,
  untilOperation,
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
import { downloadBytes, fetchInPage } from "./page-actions.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { runEditorRecoveryScenarios } from "./scenarios-editor-recovery.ts";
import { createFolder } from "./scenarios-photos.ts";
import { createLink } from "./scenarios-sharing.ts";

const ALL_APPS: readonly EditorApp[] = ["wordcraft", "gridcraft", "pdfcraft", "deckcraft"];
const DECK_VERSION = "0.14.1-hyori-host.2";

// Every native build the server accepts: the versions each committed authority revision names.
const NATIVE_VERSIONS = new Map<string, string[]>();
const TOOLING = join(import.meta.dir, "../../tooling/artcraft");

for (const name of readdirSync(TOOLING).filter((entry) =>
  /^runtime-native-v3.*\.json$/u.test(entry),
))
  for (const { app, artifactVersion } of z
    .object({ apps: z.array(z.object({ app: z.string(), artifactVersion: z.string() })) })
    .parse(JSON.parse(readFileSync(join(TOOLING, name), "utf8"))).apps)
    NATIVE_VERSIONS.set(app, [...(NATIVE_VERSIONS.get(app) ?? []), artifactVersion]);

const NATIVE_MARKER = "HYORIAUTOSAVE";
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

  for (const { app, version, protocol } of editorBundle.editors) {
    if (protocol === 2) {
      await report.check(`${app} is the native host build`, () => {
        assert.ok(NATIVE_VERSIONS.get(app)?.includes(version), `${app} ${version}`);
      });
    } else if (app === "deckcraft") {
      await report.check("Deck is the rebuilt host version", () => {
        assert.equal(version, DECK_VERSION);
      });
    }
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
      // Exactly the policy derived from the bundle being served: framing, plus its own loaders.
      assert.equal(
        headers["content-security-policy"],
        editorContentSecurityPolicy(editorBundle.directory),
      );
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

  // Modified builds must carry this product's marks, not the upstream ones.
  const modified = editorBundle.editors.filter(
    ({ app, protocol }) => protocol === 2 || app === "deckcraft",
  );

  for (const editor of modified) {
    const directory = join(editorBundle.directory, editor.app, editor.version);

    await report.check(
      `${editor.app} shows this product's icon, not the upstream mark`,
      async () => {
        const { text } = await fetchInPage(page, `${origin}${editor.assetUrl}`);
        const links = text.match(/<link\b[^>]*>/g) ?? [];
        const icon = links.find((link) => /\brel=["'](?:shortcut )?icon["']/.test(link));
        const href = icon?.match(/\bhref=["']([^"']+)["']/)?.[1];

        assert.ok(href !== undefined, `${editor.app}'s page declares no icon`);

        const { status, sha256 } = await fetchInPage(
          page,
          new URL(href, `${origin}${editor.assetUrl}`).href,
        );

        assert.equal(status, 200, `${editor.app}'s icon`);
        assert.equal(
          sha256,
          sha256Of(readFileSync(join(webRoot, "favicon.ico"))),
          `${editor.app}'s icon`,
        );
      },
    );

    await report.check(`${editor.app}'s WebAssembly no longer points at the upstream sites`, () => {
      const wasm = readdirSync(directory, { recursive: true, withFileTypes: true }).filter(
        (entry) => entry.isFile() && entry.name.endsWith(".wasm"),
      );

      assert.ok(wasm.length > 0, `${editor.app} has no WebAssembly`);

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
  await barStatus(page, OPENED_CLEAN).waitFor();
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

  // Background saves follow the person's pauses, so a protocol 2 edit may be several versions.
  if (isNative(run, item.app))
    await report.check(`${label}: the background saves are new versions`, async () => {
      report.observe(`${label} versions`, await assertEarlierVersions(page, name, 1, "at least"));
    });
  else
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
    report.observe(
      `${label} versions`,
      await assertEarlierVersions(owner, name, 1, isNative(run, item.app) ? "at least" : "exactly"),
    );
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

        if (isNative(run, "deckcraft")) {
          // A protocol 2 editor knows a converted file is copy-only before any edit, and offers
          // the copy itself instead of failing a save.
          const top = await waitForEditor(visitor, "Save a copy to keep changes");

          // With no folder, there's no name to choose either: Save a copy says so at once. Closing
          // that is a cancelled copy, so the editor goes on editing, and the capture it made is
          // the person's to download.
          await cases.deckFromPptx.edit(visitor, top, PUBLIC_MARKER);
          await barButton(visitor, "Save a copy").click();

          const dialog = visitor.getByRole("dialog");

          await dialog.getByText("This link only shares one file").waitFor({ timeout: 30_000 });
          // Photographed once it has really appeared, not in its first transparent frame.
          await visitor.locator('[role="dialog"]:not([data-starting-style])').waitFor();
          await dialog.evaluate((element) =>
            Promise.all(element.getAnimations({ subtree: true }).map(({ finished }) => finished)),
          );
          await report.shot(visitor, "deckcraft-single-link-no-folder");
          await dialog.getByRole("button", { name: "Close" }).first().click();
          await dialog.waitFor({ state: "detached" });
          await barStatus(visitor, "Save a copy to keep changes").waitFor();
          assert.ok(await barButton(visitor, "Save a copy").isEnabled(), "Save a copy is offered");

          const kept = await downloadBytes(visitor, () =>
            barButton(visitor, "Download my version").click(),
          );

          await report.shot(visitor, "deckcraft-single-link-kept");
          assertHoldsEdit(cases.deckFromPptx, kept, PUBLIC_MARKER);
          assert.equal(operationCount(front, "editors.prepareSave"), prepares, "saves attempted");

          return;
        }

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
const isNative = (run: CoreRun, app: EditorApp) =>
  run.editorBundle?.editors.some((editor) => editor.app === app && editor.protocol === 2) === true;

/** Chosen as a person does, from the account menu, which carries the product's Appearance choice. */
async function chooseAppearance(page: Page, name: "Light" | "Dark" | "System") {
  await page.getByRole("button", { name: /Noor Haddad/ }).click();
  await page.getByRole("menuitemradio", { name }).click();
  await page.keyboard.press("Escape");
}

/**
 * Protocol 2 editors: an edit reaches the server without Ctrl+S, and the editor's own chrome
 * follows the product's appearance (explicit Light and Dark override the device; System follows
 * it live). Pixels say the chrome changed; the screenshots say what it looks like.
 */
async function nativeLifecycle(run: CoreRun, cases: EditorCases) {
  const { report, editorBundle, front } = run;

  const native = new Set(
    (editorBundle?.editors ?? []).filter(({ protocol }) => protocol === 2).map(({ app }) => app),
  );

  const items = [cases.word, cases.grid, cases.deck, cases.pdf].filter(({ app }) =>
    native.has(app),
  );

  if (items.length === 0) {
    report.unverified("background saving and theme", "No protocol 2 editor is in this bundle.");

    return;
  }

  const { context, page } = await ownerPage(run, {
    viewport: EDITOR_VIEWPORT,
    colorScheme: "light",
  });

  await createFolder(page, "Native editors");
  await uploadDocuments(
    run,
    page,
    items.map((item) => item.copyAs(`native-${item.app}`)),
  );

  const folderPath = new URL(page.url()).pathname;

  await page.close();

  // Each check starts from the folder on its own page, so one failure can't strand the next.
  // A failed check is captured on its own page first: the report only knows pages it was shown.
  const fromFolder = async (label: string, check: (editorPage: Page) => Promise<void>) => {
    const editorPage = await openPage(run, context, folderPath);

    try {
      await check(editorPage);
    } catch (error) {
      await report.shot(editorPage, `FAILED-${label}`);
      throw error;
    } finally {
      await editorPage.close();
    }
  };

  for (const item of items) {
    const name = `native-${item.app}${item.extension}`;

    await report.check(`${item.label}: an edit saves in the background, with no Ctrl+S`, () =>
      fromFolder(`${item.app}-native`, async (editorPage) => {
        const top = await openFromRow(editorPage, name);
        const before = operationCount(front, "editors.completeSave", 200);

        await editDocument(editorPage, item, top, NATIVE_MARKER);
        await untilOperation(front, "editors.completeSave", before + 1);
        await barStatus(editorPage, "All changes saved").waitFor({ timeout: 20_000 });
        report.observe(`${item.label} background saves`, {
          completeSaves: operationCount(front, "editors.completeSave", 200) - before,
        });
        await closeEditor(editorPage);
        await rowIn(editorPage, name).waitFor();
        assertHoldsEdit(item, await downloadRow(editorPage, name), NATIVE_MARKER);
      }),
    );

    await report.check(`${item.label}: explicit Light and Dark override the device`, () =>
      fromFolder(`${item.app}-native`, async (editorPage) => {
        for (const appearance of ["Dark", "Light"] as const) {
          await chooseAppearance(editorPage, appearance);
          await openFromRow(editorPage, name);

          const mode = appearance === "Dark" ? "dark" : "light";
          const luminance = await untilEditorChrome(editorPage, mode);

          report.observe(`${item.label} ${mode} chrome`, {
            luminance: Math.round(luminance),
            screenshot: await report.shot(editorPage, `${item.app}-native-${mode}`),
          });
          await closeEditor(editorPage);
          await rowIn(editorPage, name).waitFor();
        }
      }),
    );

    await report.check(`${item.label}: System follows the device live, without reopening`, () =>
      fromFolder(`${item.app}-native`, async (editorPage) => {
        await chooseAppearance(editorPage, "System");
        await openFromRow(editorPage, name);
        await untilEditorChrome(editorPage, "light");
        await editorPage.emulateMedia({ colorScheme: "dark" });
        await untilEditorChrome(editorPage, "dark");
        await editorPage.emulateMedia({ colorScheme: "light" });
        await untilEditorChrome(editorPage, "light");
        await closeEditor(editorPage);
      }),
    );
  }

  await context.close();
}

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
    await report.scenario("Editors, native lifecycle", () => nativeLifecycle(run, cases), quiet);
    await runEditorRecoveryScenarios(run, cases);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
