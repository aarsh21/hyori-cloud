import { readFile, writeFile } from "node:fs/promises";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const [, , archivePath, output] = process.argv;

if (!archivePath || !output || process.argv.length !== 4)
  throw new Error(
    "Usage: bun scripts/artcraft/content-font-consumers.ts PINNED_PDF_SOURCE NEW_REFERENCE_RECORD",
  );

const archive = await readFile(archivePath);
const pin = official.editors.find((editor) => editor.app === "pdfcraft")!;

if (sha256(archive) !== pin.sourceSha256) throw new Error("PdfCraft source pin mismatch");

const members = readGitSourceArchive(
  archive,
  "pdfcraft-0.17.0",
  "7d78f3e14474b978be014715e0cc64895d77025a",
);

const references = [...members]
  .sort(([a], [b]) => a.localeCompare(b, "en"))
  .flatMap(([member, body]) => {
    if (!member.startsWith("crates/") || !member.endsWith(".rs")) return [];

    const lines = body
      .toString()
      .split("\n")
      .flatMap((text, index) =>
        /pdfcraft_fonts|crate::std14_metrics|crate::encodings/.test(text)
          ? [{ line: index + 1, text }]
          : [],
      );

    return lines.length ? [{ member, sha256: sha256(body), lines }] : [];
  });

await writeFile(
  output,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      sourceArchiveSha256: pin.sourceSha256,
      deployable: false,
      legalOpinion: false,
      scope:
        "Bounded font-crate reference witnesses, not a Rust call-graph/feature-closure proof. Includes test and unrelated font API references; not every matching file requires edits. No claim of absence for aliases/reexports or dynamically selected code.",
      directConsumers: [
        "crates/fonts/src/std14.rs",
        "crates/fonts/src/lib.rs",
        "crates/fonts/src/pdf.rs",
      ],
      references,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);

console.log(
  `Retained ${references.length} font-crate/data reference members from the pinned source archive.`,
);
