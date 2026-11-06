import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { nativeArtifactVersions } from "./native-frame-patch.ts";
import { nativeProductNames, patchNativeMarks } from "./native-v3-marks.ts";
import { nativePolishedApps, patchNativePolish } from "./native-v3-polish.ts";
import {
  composeNativeSource,
  nativeApps,
  nativeAuthoredInputs,
  readPinnedSource,
} from "./native-v3-source.ts";

const inputs = z.object({ ARTCRAFT_TEST_INPUTS: z.string().optional() }).parse(process.env);
const legal = ["LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "ATTRIBUTION.md", "docs/brand/LICENSE-brand.txt"];

/** Upstream promotion a person could see or click in the browser build. */
const promotion = /discord\.gg|getartcraft\.com|"[^"\n]*Discord[^"\n]*"|docs\/brand\/artcraft|assets\/app-icon/u;

test("marks patch fails closed on a missing upstream anchor", () => {
  const empty = new Map([["Cargo.lock", Buffer.from("lock")]]);
  const marks = { favicon: Buffer.from("ico"), icon: Buffer.from("png") };

  for (const app of ["wordcraft", "gridcraft", "pdfcraft"] as const)
    expect(() => patchNativeMarks(empty, app, marks)).toThrow();
});

test("hosted polish fails closed on a missing upstream anchor", () => {
  for (const app of nativePolishedApps)
    expect(() => patchNativePolish(new Map([["Cargo.lock", Buffer.from("lock")]]), app)).toThrow();
});

for (const app of nativeApps)
  test.skipIf(!inputs.ARTCRAFT_TEST_INPUTS)(
    `${app} v3 composition connects the host, removes upstream marks and keeps legal bytes and locks`,
    async () => {
      const config = z
        .object({ editors: z.array(z.object({ app: z.string(), sourceArchive: z.string() })) })
        .parse(JSON.parse(await readFile(inputs.ARTCRAFT_TEST_INPUTS!, "utf8")));

      const archive = await readFile(config.editors.find((editor) => editor.app === app)!.sourceArchive);
      const { original } = readPinnedSource(app, archive);
      const snapshot = new Map([...original].map(([path, body]) => [path, Buffer.from(body)]));
      const result = await composeNativeSource(app, original, await nativeAuthoredInputs());

      expect(result.version).toBe(nativeArtifactVersions[app]);
      const polished = nativePolishedApps.some((name) => name === app);

      expect(result.stages.slice(-2)).toEqual(
        polished ? ["marks-removed", "hyori-host-polish"] : [result.stages.at(-2), "marks-removed"],
      );

      const ui = (path: string) => result.files.get(`crates/ui-egui/src/${path}`)!.toString();

      if (app === "wordcraft") {
        // Hyori owns sharing and the account: both upstream controls are drawn only standalone.
        expect(ui("ribbon.rs")).toContain("if !hosted {\n                        let (share_size, share_text) =");
        expect(ui("chrome.rs")).toContain(
          "if app.native_host_intents.is_none() {\n                    let (r, resp) = ui.allocate_exact_size(vec2(control_h, control_h), Sense::click());",
        );
      }

      if (app === "deckcraft") expect(ui("ribbon/title_bar.rs")).not.toContain("Icon::Sparkle");

      for (const [path, body] of snapshot) expect(original.get(path)!.equals(body)).toBe(true);

      for (const path of legal) expect(result.files.get(path)!.equals(original.get(path)!)).toBe(true);
      expect(result.changes.some((change) => change.path.endsWith("Cargo.toml"))).toBe(false);
      expect(result.changes.some((change) => change.path === "Cargo.lock")).toBe(false);

      const web = result.files.get(`apps/${app}-web/src/native_host.rs`)!.toString();
      expect(web).toContain(`"${nativeArtifactVersions[app]}"`);
      expect(result.files.get(`apps/${app}-web/index.html`)!.toString()).toContain(
        `<title>${nativeProductNames[app]}</title>`,
      );

      for (const [path, body] of result.files) {
        const browserUi =
          (path.startsWith("crates/ui-egui/src/") || path.startsWith(`apps/${app}-web/`)) &&
          !path.includes("/i18n/") &&
          !/(^|\/)tests?(\.rs|\/)/u.test(path);

        if (!browserUi || !/\.(rs|html)$/u.test(path)) continue;
        // Doc comments and test modules may still name upstream things; shipped strings may not.

        const shipped = body
          .toString()
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("//"))
          .join("\n")
          .split("#[cfg(test)]")[0]!;

        expect({ path, match: shipped.match(promotion)?.[0] ?? null }).toEqual({ path, match: null });
      }
    },
    120000,
  );
