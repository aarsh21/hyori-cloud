import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const [, , sourceArchive, cargoCache, publicResearch, afmResearch, destination] = process.argv;

if (
  !sourceArchive ||
  !cargoCache ||
  !publicResearch ||
  !afmResearch ||
  !destination ||
  process.argv.length !== 7
)
  throw new Error(
    "Usage: bun scripts/artcraft/content-font-retain.ts PINNED_PDF_SOURCE PUBLIC_CARGO_CACHE PUBLIC_RESEARCH AFM_RESEARCH NEW_OUTPUT",
  );

const source = await readFile(sourceArchive);
const pin = official.editors.find((editor) => editor.app === "pdfcraft")!;

if (sha256(source) !== pin.sourceSha256) throw new Error("PdfCraft source pin mismatch");

const pdf = readGitSourceArchive(
  source,
  "pdfcraft-0.17.0",
  "7d78f3e14474b978be014715e0cc64895d77025a",
);

const output = resolve(destination);

await mkdir(output);

const records: {
  id: string;
  member: string;
  source: string;
  path: string;
  bytes: number;
  sha256: string;
}[] = [];

async function retain(id: string, member: string, source: string, body: Buffer) {
  const path = `${records.length}.txt`;
  await writeFile(join(output, path), body, { flag: "wx" });
  records.push({ id, member, source, path, bytes: body.length, sha256: sha256(body) });
}

const members = [
  "vendor/hayro-interpret/src/font/blob.rs",
  "vendor/hayro-interpret/src/font/standard_font.rs",
  "vendor/hayro-interpret/src/font/generated/standard.rs",
  "vendor/hayro-interpret/src/font/generated/symbol.rs",
  "vendor/hayro-interpret/src/font/generated/zapf_dings.rs",
  "vendor/hayro-interpret/Cargo.toml",
  "vendor/hayro-interpret/assets/LICENSE_FOXIT",
];

for (const member of members) {
  const body = pdf.get(member);

  if (!body) throw new Error(`Source witness missing: ${member}`);
  await retain(`pdf:${member}`, member, `${pin.sourceUrl}#${pin.sourceSha256}`, body);
}

for (const name of [
  "Sans",
  "SansBold",
  "SansItalic",
  "SansBoldItalic",
  "Serif",
  "SerifBold",
  "SerifItalic",
  "SerifBoldItalic",
  "Fixed",
  "FixedBold",
  "FixedItalic",
  "FixedBoldItalic",
  "Symbol",
  "Dingbats",
]) {
  const member = `vendor/hayro-interpret/assets/Foxit${name}.pfb`;
  const body = pdf.get(member);

  if (!body) throw new Error(`Existing Foxit input missing: ${member}`);
  await retain(`font:${name}`, member, `${pin.sourceUrl}#${pin.sourceSha256}`, body);
}

for (const [name, version, checksum, paths] of [
  [
    "read-fonts",
    "0.44.0",
    "d5a0cf4bb6cbce4c29756270d189a5e400ac05e91192161d83a0bcb6e68492e8",
    [
      "src/ps/cff/font.rs",
      "src/ps/cff.rs",
      "src/ps/string.rs",
      "src/ps/cs.rs",
      "src/ps/encoding.rs",
      "src/ps/agl.rs",
      "data/glyphlist.txt",
      "LICENSE-MIT",
      "LICENSE-APACHE",
    ],
  ],
  [
    "skrifa",
    "0.47.0",
    "526e654b303ff4ad73a5a40b25de2b3ce3d039c5e3b6da5f89ae6e57004cb40f",
    ["src/lib.rs", "Cargo.toml"],
  ],
] satisfies [string, string, string, string[]][]) {
  const archive = await readFile(
    join(cargoCache, "registry/cache/index.crates.io-1949cf8c6b5b557f", `${name}-${version}.crate`),
  );

  if (sha256(archive) !== checksum)
    throw new Error(`Locked parser crate checksum mismatch: ${name}`);
  const entries = readCrateArchive(archive, `${name}-${version}`);

  for (const member of paths) {
    const body = entries.get(member);

    if (!body) throw new Error(`Locked parser source member missing: ${member}`);
    await retain(
      `${name}:${member}`,
      member,
      `https://static.crates.io/crates/${name}/${name}-${version}.crate#${checksum}`,
      body,
    );
  }
}

const publicSchema = z.object({
  records: z.array(
    z.object({
      id: z.string().optional(),
      name: z.string().optional(),
      path: z.string(),
      url: z.string(),
      bytes: z.number(),
      sha256: z.string(),
    }),
  ),
});

for (const root of [publicResearch, afmResearch]) {
  const manifest = await readFile(join(root, "sources.json"));
  const sources = publicSchema.parse(JSON.parse(manifest.toString()));

  for (const record of sources.records) {
    if (!/^[a-zA-Z0-9._-]+$/.test(record.path)) throw new Error("Unsafe research witness path");
    const body = await readFile(join(root, record.path));

    if (body.length !== record.bytes || sha256(body) !== record.sha256)
      throw new Error("Research source bytes changed");
    await retain(record.id ?? `afm:${record.name}`, record.path, record.url, body);
  }

  await retain(
    `research-catalog:${records.length}`,
    "sources.json",
    "local-public-research-catalog",
    manifest,
  );
}

const index = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, deployable: false, fullNoticeAuditComplete: false, compilerGeneratedNoticeAuditComplete: false, protectedMarksCleared: false, legalOpinion: false, records }, null, 2)}\n`,
);

await writeFile(join(output, "index.json"), index, { flag: "wx" });

console.log(JSON.stringify({ records: records.length, indexSha256: sha256(index) }));
