import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { syntheticDeckCraft } from "../../artcraft/deckcraft-synthetic.ts";
import { candidateArtifactVersions } from "../../artcraft/native-v3-candidate.ts";

export type EditorApp = "wordcraft" | "gridcraft" | "pdfcraft" | "deckcraft";

export type EditorCase = {
  readonly app: EditorApp;
  /** How this case reads in a report. */
  readonly label: string;
  readonly extension: string;
  /** The synthetic source document. */
  readonly source: string;
  /**
   * A real edit in the real editor, in a 1280×800 frame `top` pixels down the page. Every position
   * comes from a real render of these documents, so a changed layout fails rather than passes.
   */
  readonly edit: (page: Page, top: number, marker: string) => Promise<void>;
  /** What a person must be able to read on the reopened document, which no check here can. */
  readonly shows: (marker: string) => string;
  /** Whether saved bytes hold the edit, read outside the editor. */
  readonly contains: (saved: Buffer, marker: string) => boolean;
  /** Copies the source under a name of its own, for one flow's upload. */
  readonly copyAs: (name: string) => string;
};

/** Every member of a saved document, so an edit is found wherever its format keeps it. */
function zipContains(work: string, saved: Buffer, text: string) {
  const path = join(work, "saved-inspect.zip");

  writeFileSync(path, saved);

  const result = spawnSync(
    "python3",
    [
      "-I",
      "-c",
      "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print('yes' if any(sys.argv[2].encode() in z.read(n) for n in z.namelist()) else 'no')",
      path,
      text,
    ],
    { encoding: "utf8" },
  );

  if (result.status !== 0) throw new Error(`Couldn't read the saved document: ${result.stderr}`);

  return result.stdout.trim() === "yes";
}

const usesCandidate = (page: Page, app: EditorApp) =>
  page
    .frames()
    .some((frame) => frame.url().includes(`/artcraft/${app}/${candidateArtifactVersions[app]}/`));

/** The synthetic documents and how to really edit each. Nothing here comes from outside the repo. */
export function createEditorCases(work: string) {
  const documents = join(work, "documents");
  const uploads = join(work, "uploads");

  mkdirSync(uploads, { recursive: true });

  const written = spawnSync(
    "python3",
    ["-I", "scripts/browser-fixtures/editor-probe/documents.py", documents],
    { stdio: "inherit" },
  );

  if (written.status !== 0) throw new Error("The synthetic editor documents weren't written.");

  writeFileSync(join(documents, "probe.deckcraft"), syntheticDeckCraft());

  const inZip = (saved: Buffer, marker: string) => zipContains(work, saved, marker);

  function editorCase(
    app: EditorApp,
    label: string,
    extension: string,
    shows: EditorCase["shows"],
    edit: EditorCase["edit"],
    contains: EditorCase["contains"] = inZip,
  ): EditorCase {
    const source = join(documents, `probe${extension}`);

    return {
      app,
      label,
      extension,
      shows,
      source,
      edit,
      contains,
      copyAs(name) {
        const path = join(uploads, `${name}${extension}`);

        copyFileSync(source, path);

        return path;
      },
    };
  }

  /** Selects what's at this position, types into it, and leaves it. */
  const typeIntoDeck =
    (x: number, y: number, appendToText = false): EditorCase["edit"] =>
    async (page, top, marker) => {
      if (appendToText) await page.mouse.dblclick(x, top + y, { delay: 80 });
      else await page.mouse.click(x, top + y);
      await page.waitForTimeout(1000);

      if (appendToText) await page.keyboard.press("End");
      await page.keyboard.type(marker, { delay: 120 });
      await page.waitForTimeout(800);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(800);
    };

  return {
    word: editorCase(
      "wordcraft",
      "Word",
      ".docx",
      (marker) => `${marker} in the body text, with “Original words.”`,
      async (page, top, marker) => {
        await page.mouse.click(640, top + 400);
        await page.waitForTimeout(800);
        await page.keyboard.type(marker, { delay: 60 });
        await page.waitForTimeout(500);
      },
    ),
    grid: editorCase(
      "gridcraft",
      "Grid",
      ".xlsx",
      (marker) => `${marker} in a cell, with 41 still in A1`,
      async (page, top, marker) => {
        // A real cell, pressed at a person's pace: this editor can miss a press and release that
        // arrive within one slow software-rendered frame. F2 starts editing it.
        await page.mouse.move(104, top + 279);
        await page.waitForTimeout(400);
        await page.mouse.down();
        await page.waitForTimeout(200);
        await page.mouse.up();
        await page.waitForTimeout(800);
        await page.keyboard.press("F2");
        await page.waitForTimeout(500);
        await page.keyboard.type(marker, { delay: 120 });
        await page.waitForTimeout(500);
        await page.keyboard.press("Enter");
        await page.waitForTimeout(800);
      },
    ),
    // Clicking lands a caret in the title placeholder.
    deck: editorCase(
      "deckcraft",
      "Deck",
      ".deckcraft",
      (marker) => `${marker} as the slide's title`,
      typeIntoDeck(757, 345),
    ),
    deckFromPptx: editorCase(
      "deckcraft",
      "Deck from PPTX",
      ".pptx",
      (marker) => `${marker} in the text box, with “Original slide.”`,
      (page, top, marker) =>
        (usesCandidate(page, "deckcraft") ? typeIntoDeck(620, 273, true) : typeIntoDeck(757, 300))(
          page,
          top,
          marker,
        ),
    ),
    // The pen tool, drawn across the page: the bytes distinguish ink from a comment, and the
    // reopened render checks where the stroke actually appears.
    pdf: editorCase(
      "pdfcraft",
      "Pdf",
      ".pdf",
      () => "a drawn ink stroke across the page, with “Original words.” under it",
      async (page, top) => {
        // PDFCraft 0.22 has more tools above the pen in its floating toolbar.
        await page.mouse.click(309, top + (usesCandidate(page, "pdfcraft") ? 327 : 259));
        await page.waitForTimeout(1000);
        await page.mouse.move(500, top + 400);
        await page.mouse.down();

        for (let step = 1; step <= 12; step += 1) {
          await page.mouse.move(500 + step * 25, top + 400 + step * 10);
          await page.waitForTimeout(40);
        }

        await page.mouse.up();
        await page.waitForTimeout(1000);
      },
      (saved) => /\/Subtype\s*\/Ink\b/.test(saved.toString("latin1")),
    ),
  };
}

export type EditorCases = ReturnType<typeof createEditorCases>;
