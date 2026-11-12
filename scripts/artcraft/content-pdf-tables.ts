import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import {
  contentCorrespondence,
  parsePdfFontTable,
  pdfDecisionRoot,
} from "./content-correspondence.ts";
import { readAcquisitionFile } from "./content-delivery.ts";
import { validateZipArchive, expandZipEntry } from "./validated-zip.ts";
import { inspectWasm } from "./content-binary.ts";
import { sha256 } from "./evidence-bytes.ts";

/** Narrow source-to-output check: serialize known numeric tables, never execute vendor code. */
export async function checkPdfCompiledTables(releaseArchive: string) {
  const decision = await contentCorrespondence();
  const pin = official.editors.find((editor) => editor.app === "pdfcraft")!;
  const archive = await readFile(releaseArchive);

  if (archive.length !== pin.bytes || sha256(archive) !== pin.sha256)
    throw new Error("PdfCraft release archive pin mismatch");
  const entries = validateZipArchive(archive, pin.archiveRoot, official.limits);
  const wasm = entries.filter((entry) => !entry.directory && entry.path.endsWith(".wasm"));

  if (wasm.length !== 1) throw new Error("Expected exactly one PdfCraft WASM");
  const body = expandZipEntry(wasm[0]!);
  const { memory } = inspectWasm(body);

  async function source(member: string) {
    const file = decision.pdfcraft.files.find((file) => file.member === member)!;
    const bytes = await readAcquisitionFile(pdfDecisionRoot, file.path);

    if (sha256(bytes) !== file.sha256) throw new Error("PdfCraft numeric source changed");

    return bytes;
  }

  const metrics = await source("crates/fonts/src/std14_metrics.rs");
  const encoding = await source("crates/fonts/src/encodings.rs");

  const widths = z
    .array(z.array(z.number().int().nonnegative().max(65535)).length(256))
    .length(14)
    .parse(parsePdfFontTable(metrics, "WIDTHS"));

  const tables: { name: string; sourceMember: string; bytes: Buffer }[] = [];

  function widthBytes(values: number[]) {
    const bytes = Buffer.alloc(values.length * 2);

    for (const [index, value] of values.entries()) bytes.writeUInt16LE(value, index * 2);

    return bytes;
  }

  tables.push({
    name: "WIDTHS",
    sourceMember: "crates/fonts/src/std14_metrics.rs",
    bytes: widthBytes(widths.flat()),
  });

  for (const [index, row] of widths.entries())
    tables.push({
      name: `WIDTHS[${index}]`,
      sourceMember: "crates/fonts/src/std14_metrics.rs",
      bytes: widthBytes(row),
    });

  for (const name of ["WIN_ANSI", "MAC_ROMAN", "STANDARD"]) {
    const values = z
      .array(z.number().int().nonnegative().max(0x10ffff))
      .length(256)
      .parse(parsePdfFontTable(encoding, name));

    const bytes = Buffer.alloc(values.length * 4);

    for (const [index, value] of values.entries()) bytes.writeUInt32LE(value, index * 4);
    tables.push({ name, sourceMember: "crates/fonts/src/encodings.rs", bytes });
  }

  return {
    schemaVersion: 1,
    artifact: "pdfcraft@0.17.0",
    archiveSha256: pin.sha256,
    wasm: { path: wasm[0]!.path, sha256: sha256(body) },
    deployable: false,
    fullNoticeAuditComplete: false,
    legalOpinion: false,
    method:
      "Static active-memory search for exact little-endian numeric table serialization. Positive observations establish data identity, not unique authorship/source origin, upstream rights or independent toolchain attestation. A miss never proves absence.",
    tables: tables.map((table) => {
      const offsets: number[] = [];
      let offset = memory.indexOf(table.bytes);

      while (offset >= 0 && offsets.length < 32) {
        offsets.push(offset);
        offset = memory.indexOf(table.bytes, offset + 1);
      }

      return {
        name: table.name,
        sourceMember: table.sourceMember,
        bytes: table.bytes.length,
        sha256: sha256(table.bytes),
        offsets,
        allOccurrencesRecorded: offset < 0,
        disposition: offsets.length
          ? "exact-numeric-bytes-observed-rights-unresolved"
          : "no-exact-observation-not-evidence-of-absence",
      };
    }),
  };
}

if (import.meta.main) {
  const [, , archive, output] = process.argv;

  if (!archive || ![3, 4].includes(process.argv.length))
    throw new Error(
      "Usage: bun scripts/artcraft/content-pdf-tables.ts PINNED_LOCAL_RELEASE_ZIP [NEW_OUTPUT]",
    );
  const bytes = Buffer.from(`${JSON.stringify(await checkPdfCompiledTables(archive), null, 2)}\n`);

  if (output) await writeFile(output, bytes, { flag: "wx" });
  else {
    if (!(await readFile(join(pdfDecisionRoot, "compiled-tables.json"))).equals(bytes))
      throw new Error("PdfCraft compiled-table evidence changed");
    console.log(
      "Verified exact compiled PdfCraft numeric-table observations; rights and deployment remain unresolved.",
    );
  }
}
