import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import pins from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { nativePalette } from "./native-palette.ts";
import { patchNativeChrome } from "./native-chrome-patch.ts";
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const css = await readFile("packages/ui/src/styles/globals.css");
const appName = z.enum(["wordcraft", "gridcraft", "pdfcraft", "deckcraft"]);

const sourceCommits = {
  wordcraft: "5cd53f184aab11def13b7fced18727159b9bc96a",
  gridcraft: "30b210b4ef03b30616923465efa70766cefba379",
  pdfcraft: "7d78f3e14474b978be014715e0cc64895d77025a",
  deckcraft: "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
};

const inputs = z.object({ ARTCRAFT_TEST_INPUTS: z.string().optional() }).parse(process.env);

test("native palette comes from canonical shared CSS, including opaque white dark ink and alpha hairlines", () => {
  const palette = nativePalette(css);
  expect(palette.cssSha256).toBe(sha256(css));
  expect(palette.dark.get("foreground")).toEqual([255, 255, 255, 255]);
  expect(palette.dark.get("border")).toEqual([255, 255, 255, 20]);
  expect(
    palette.light
      .get("foreground")!
      .slice(0, 3)
      .every((channel) => channel < 40),
  ).toBe(true);
  expect(palette.light.get("background")![0]).toBeGreaterThan(230);
});

test("palette input fails closed for missing/duplicate selector/token or unsupported color syntax", () => {
  const text = css.toString();

  for (const altered of [
    text.replace(":root {", ".missing {"),
    `${text}\n.dark {}`,
    text.replace("--background:", "--missing:"),
    text.replace("oklch(0.95 0.009 85)", "red"),
  ])
    expect(() => nativePalette(Buffer.from(altered))).toThrow();
});

for (const app of appName.options)
  test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
    `${app} native token patch changes only UI constructors, preserving fonts, content models and all original legal bytes`,
    async () => {
      const config = z
        .object({ editors: z.array(z.object({ app: appName, sourceArchive: z.string() })) })
        .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

      const archive = await readFile(
        config.editors.find((editor) => editor.app === app)!.sourceArchive,
      );

      const pin = pins.editors.find((editor) => editor.app === app)!;
      expect(sha256(archive)).toBe(pin.sourceSha256);
      const source = readGitSourceArchive(archive, `${app}-${pin.version}`, sourceCommits[app]);
      const patched = patchNativeChrome(source, app, css);
      expect(patched.cssSha256).toBe(sha256(css));
      expect(patched.changes.length).toBe(1);
      const themePath = "crates/ui-egui/src/theme.rs";
      const before = source.get(themePath)!.toString();
      const after = patched.files.get(themePath)!.toString();
      expect(after).not.toBe(before);
      expect(after).toContain("Color32::from_rgba_unmultiplied(255, 255, 255, 255)");
      const fontStart = before.indexOf("pub fn install_fonts");

      if (fontStart >= 0)
        expect(after.slice(after.indexOf("pub fn install_fonts"))).toBe(before.slice(fontStart));

      for (const [path, body] of source)
        if (path !== themePath) expect(patched.files.get(path)!.equals(body)).toBe(true);

      for (const field of [
        "grid_bg",
        "cell_text",
        "gridline",
        "sheet_ref_colors",
        "guide",
        "find_highlight",
        "page_shadow",
        "text_selection",
      ]) {
        const pattern = new RegExp(`^\\s+${field}: [^\\n]+$`, "gm");
        expect([...after.matchAll(pattern)].map((match) => match[0])).toEqual(
          [...before.matchAll(pattern)].map((match) => match[0]),
        );
      }

      const changedAnchor = new Map(source);
      changedAnchor.set(
        themePath,
        Buffer.from(
          before.replace(
            /pub fn light\(\)|fn palette\(dark: bool\)|ThemeKind::Light => Self/g,
            "unexpected_anchor",
          ),
        ),
      );
      expect(() => patchNativeChrome(changedAnchor, app, css)).toThrow("anchor");
    },
    120000,
  );
