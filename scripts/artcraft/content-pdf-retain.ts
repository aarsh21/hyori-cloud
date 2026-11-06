import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const [, , archivePath, destination] = process.argv;

if (!archivePath || !destination || process.argv.length !== 4)
  throw new Error(
    "Usage: bun scripts/artcraft/content-pdf-retain.ts EXISTING_SOURCE_ARCHIVE NEW_OUTPUT",
  );

const pin = official.editors.find((editor) => editor.app === "pdfcraft")!;
const archive = await readFile(archivePath);

if (sha256(archive) !== pin.sourceSha256) throw new Error("PdfCraft source archive pin mismatch");

const commit = "7d78f3e14474b978be014715e0cc64895d77025a";
const members = readGitSourceArchive(archive, "pdfcraft-0.17.0", commit);
const output = resolve(destination);

await mkdir(output);

const files = [];

for (const member of [
  "crates/fonts/src/std14_metrics.rs",
  "crates/fonts/src/encodings.rs",
  "crates/fonts/src/std14.rs",
  "crates/fonts/src/lib.rs",
  "crates/fonts/src/pdf.rs",
  "ATTRIBUTION.toml",
  "AGENTS.md",
  "vendor/hayro-interpret/src/font/standard_font.rs",
  "vendor/hayro-interpret/assets/LICENSE_FOXIT",
]) {
  const body = members.get(member);

  if (!body) throw new Error(`Missing PdfCraft decision source: ${member}`);
  const path: string = `${files.length}.txt`;
  await writeFile(join(output, path), body, { flag: "wx" });
  files.push({ member, path, bytes: body.length, sha256: sha256(body) });
}

const index = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, sourceArchiveSha256: pin.sourceSha256, commit, deployable: false, files }, null, 2)}\n`,
);

await writeFile(join(output, "index.json"), index, { flag: "wx" });

console.log(JSON.stringify({ files: files.length, indexSha256: sha256(index) }));
