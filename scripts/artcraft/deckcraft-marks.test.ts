import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { DECK_MARKS_VERSION, patchDeckMarks } from "./deckcraft-marks.ts";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { readGitSourceArchive } from "./evidence-bytes.ts";

const SOURCE_ARCHIVE = process.env.ARTCRAFT_TEST_DECK_SOURCE;

const INPUTS = {
  favicon: readFileSync("apps/web/public/favicon.ico"),
  icon: readFileSync("apps/web/public/icon-192.png"),
};

describe("the Deck marks patch", () => {
  test("fails closed when an upstream anchor is missing", () => {
    expect(() => patchDeckMarks(new Map([["Cargo.lock", Buffer.from("x")]]), INPUTS)).toThrow(
      /Nonunique patch anchor/,
    );
  });

  test("is a new version, distinct from the retained historical build", () => {
    expect(DECK_MARKS_VERSION).toBe("0.14.1-hyori-host.2");
  });

  test.skipIf(SOURCE_ARCHIVE === undefined || !existsSync(SOURCE_ARCHIVE))(
    "applies to the pinned source, keeping attribution and removing the marks",
    () => {
      const original = readGitSourceArchive(
        readFileSync(SOURCE_ARCHIVE ?? ""),
        "deckcraft-0.14.1",
        "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
      );

      const { files } = patchDeckCraft(original, {
        hostRust: readFileSync("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
        hostJavaScript: readFileSync(
          "tooling/artcraft/patches/deckcraft-host-v2/host-bridge.js.source",
        ),
      });

      const { files: patched, changes } = patchDeckMarks(files, INPUTS);
      const text = (path: string) => patched.get(path)?.toString() ?? "";

      expect(patched.get("Cargo.lock")?.equals(original.get("Cargo.lock")!)).toBe(true);
      expect(patched.get("apps/deckcraft-web/hyori-mark.ico")?.equals(INPUTS.favicon)).toBe(true);
      expect(text("apps/deckcraft-web/index.html")).not.toContain("app-icon/deckcraft.ico");
      expect(text("crates/ui-egui/src/lib.rs")).not.toContain("ai.storyteller.deckcraft.png");
      expect(text("apps/deckcraft-web/src/host.rs")).toContain(DECK_MARKS_VERSION);

      const about = text("crates/ui-egui/src/dialogs/about.rs");

      expect(about).toContain("Based on DeckCraft by the ArtCraft team.");
      expect(about).toContain("© 2026 ArtCraft Team and the DeckCraft contributors");
      expect(about).not.toContain("Color32::from_rgb(0xF2, 0x6B, 0x1D)");
      expect(text("crates/engine/src/links.rs")).not.toContain("getartcraft.com");

      for (const legal of ["NOTICE", "ATTRIBUTION.md", "LICENSE-MIT", "LICENSE-APACHE"]) {
        expect(patched.get(legal)?.equals(original.get(legal)!)).toBe(true);
      }

      expect(changes.some(({ path }) => path === "NOTICE")).toBe(false);

      // An ordinary Save of a PPTX makes a native copy, and only for a PPTX.
      const appFiles = text("crates/ui-egui/src/app/files.rs");

      expect(appFiles).toContain('(format!("{}.deckcraft", d.title()), true)');
      expect(appFiles).toContain('.ends_with(".pptx")');
      expect(appFiles).toContain("(path, save_as)");
      expect(appFiles).toContain("send(d, &name, &bytes, save_as)?");
      expect(appFiles).not.toContain('None => d.path.clone().ok_or("No host output filename")?,');

      // The final bridge is the v2 one, which is what permits a read-only copy.
      const bridge = text("apps/deckcraft-web/hyori-host.js");

      expect(bridge).toContain("!active.descriptor.writable && !saveAs");
    },
  );

  test.skipIf(SOURCE_ARCHIVE === undefined || !existsSync(SOURCE_ARCHIVE))(
    "the historical build's inputs are untouched",
    () => {
      const original = readGitSourceArchive(
        readFileSync(SOURCE_ARCHIVE ?? ""),
        "deckcraft-0.14.1",
        "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
      );

      const { files } = patchDeckCraft(original, {
        hostRust: readFileSync("tooling/artcraft/patches/deckcraft-host-v1/host.rs"),
        hostJavaScript: readFileSync(
          "tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/host-bridge.js.source",
        ),
      });

      const appFiles = files.get("crates/ui-egui/src/app/files.rs")?.toString() ?? "";

      expect(appFiles).toContain('None => d.path.clone().ok_or("No host output filename")?,');
      expect(files.get("apps/deckcraft-web/src/host.rs")?.toString()).toContain("hyori-host.1");
    },
  );
});
