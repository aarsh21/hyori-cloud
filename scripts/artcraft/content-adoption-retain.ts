import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { fontDataFeasibility, fontFeasibilityRoot } from "./content-font-feasibility.ts";
import { pdfDecisionRoot } from "./content-correspondence.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , destination] = process.argv;

if (!destination || process.argv.length !== 3)
  throw new Error("Usage: bun scripts/artcraft/content-adoption-retain.ts NEW_NOTICE_ADOPTION");

const result = await fontDataFeasibility();

if (result.totals.afmEqual !== 3584 || result.glyphNames.equal !== 231)
  throw new Error("Existing-data basis changed");

const index = z
  .object({
    records: z.array(
      z.object({ id: z.string(), path: z.string(), source: z.string(), sha256: z.string() }),
    ),
  })
  .parse(JSON.parse(await readFile(join(fontFeasibilityRoot, "index.json"), "utf8")));

const output = resolve(destination);

await mkdir(output);

const records: { path: string; source: string; bytes: number; sha256: string }[] = [];

async function retain(path: string, source: string, body: Buffer) {
  await mkdir(dirname(join(output, "files", path)), { recursive: true });
  await writeFile(join(output, "files", path), body, { flag: "wx" });
  records.push({ path, source, bytes: body.length, sha256: sha256(body) });
}

for (const record of index.records) {
  let path: string | undefined;

  if (record.id.startsWith("afm:")) path = `adobe-core14/${record.id.slice(4)}.afm`;

  if (record.id.endsWith("pdfcorefonts/readme.txt")) path = "adobe-core14/readme.txt";

  if (record.id === "adobe-agl-glyphlist") path = "adobe-agl/glyphlist.txt";

  if (record.id.startsWith("chromium/pdfium:") && !record.id.endsWith("commit-observation"))
    path = `pdfium/${record.id.slice("chromium/pdfium:".length)}`;

  if (!path) continue;
  const body = await readFile(join(fontFeasibilityRoot, record.path));

  if (sha256(body) !== record.sha256) throw new Error("Adoption source bytes changed");
  await retain(path, record.source, body);
}

for (const [file, path] of [
  ["0.txt", "existing-source/std14_metrics.rs.txt"],
  ["1.txt", "existing-source/encodings.rs.txt"],
])
  await retain(
    path!,
    "pdfcraft@7d78f3e14474b978be014715e0cc64895d77025a; unchanged original member",
    await readFile(join(pdfDecisionRoot, file!)),
  );

await retain(
  "correspondence.json",
  "Reproduced from exact retained font/data witnesses; not historical-generation attestation",
  Buffer.from(`${JSON.stringify(result, null, 2)}\n`),
);

await retain(
  "ADOPTION.md",
  "Hyori distribution composition record; does not modify original inputs or vendor assets",
  Buffer.from(
    `# Existing PdfCraft data: distribution notice adoption\n\nTechnical redistribution composition, not legal opinion or full audit clearance. The unchanged official PdfCraft release is used. No font, mapping implementation, numeric table, JavaScript or WASM is replaced or modified.\n\nThe fourteen complete Adobe AFMs and their original copyrights are accompanied by the exact readme permission paragraph. It permits use/copy/distribution with or without modification, requires retaining copyrights and this file with the AFMs, prominent notices of modifications, and an unchanged permission paragraph. None of the retained AFMs/readme is modified. The documented transformation witness joins glyph names/codes and widths into the existing 14x256 numeric representation; it reproduces all 3584 slots under the explicitly stated current undefined-code policy. This describes the correspondence/conversion, not the historical authors' exact inputs. Existing Rust source is preserved separately. Project MIT/Apache does not replace these asset-specific terms.\n\nThe complete Adobe AGL carries its own BSD-style grant/copyright/disclaimer and reproduces all 231 existing glyph-name pairs. PDFium's complete file-level BSD-noticed mapping source, LICENSE and AUTHORS are included. Those terms remain attached, including no-endorsement requirements; this adoption does not relabel third-party material.\n\nCurrent mapping behavior is deliberately preserved: Standard matches PDFium; six WinAnsi undefined codes remain undefined rather than becoming PDFium bullet aliases; MacRoman retains modern Omega U+03A9 and Euro U+20AC at 0xBD/0xDB, and PDF-specific ordinary space at 0xCA. AGL Omegagreek and Euro provide explicit permissively licensed scalar correspondences. This compatibility policy is documented, not newly implemented. Raw PDFium direct tables differ; their presence as evidence is not adoption of their behavior. No font replacement or mapping algorithm change is needed to ship the unchanged official asset on this supported notice composition.\n\nThe old audit remains a historical confidence snapshot. Absence of a unique historical compiler/link proof or of every optimized byte's unique source is residual confidence, not a new permission condition. No legal advice, endorsement, trademark grant beyond upstream terms, general product acceptance or clearance is asserted.\n`,
  ),
);

const catalog = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, kind: "express-permission-existing-data-notice-adoption", legalOpinion: false, fullNoticeAuditComplete: false, compilerGeneratedNoticeAuditComplete: false, vendorBytesModified: false, mappingsModified: false, files: records.sort((a, b) => a.path.localeCompare(b.path, "en")) }, null, 2)}\n`,
);

await writeFile(join(output, "index.json"), catalog, { flag: "wx" });

console.log(JSON.stringify({ files: records.length, indexSha256: sha256(catalog) }));
