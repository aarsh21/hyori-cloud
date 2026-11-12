import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const [, , cargo, pdfArchive, destination] = process.argv;

if (!cargo || !pdfArchive || !destination || process.argv.length !== 5)
  throw new Error(
    "Usage: bun scripts/artcraft/content-font-parser-retain.ts PUBLIC_CARGO_CACHE PINNED_PDF_SOURCE NEW_OUTPUT",
  );

const output = resolve(destination);

await mkdir(output);

const records: { member: string; source: string; path: string; bytes: number; sha256: string }[] =
  [];

async function retain(member: string, source: string, body: Buffer) {
  const path = `${records.length}.txt`;
  await writeFile(join(output, path), body, { flag: "wx" });
  records.push({ member, source, path, bytes: body.length, sha256: sha256(body) });
}

for (const [crate, version, checksum, paths] of [
  [
    "read-fonts",
    "0.41.0",
    "046a7d674daf459825b32f5062056d6882db0d2f5a479fbd76ccfc870ac18709",
    ["src/ps/cff/font.rs", "src/lib.rs"],
  ],
  [
    "skrifa",
    "0.44.0",
    "819ab7d62b1d3e72d9d9dea5650bac30424f9111364bb94928dbf5ecad1baa68",
    ["src/lib.rs", "Cargo.toml"],
  ],
] satisfies [string, string, string, string[]][]) {
  const bytes = await readFile(
    join(cargo, "registry/cache/index.crates.io-1949cf8c6b5b557f", `${crate}-${version}.crate`),
  );

  if (sha256(bytes) !== checksum) throw new Error("Locked font-helper parser checksum mismatch");
  const files = readCrateArchive(bytes, `${crate}-${version}`);

  for (const path of paths) {
    const body = files.get(path);

    if (!body) throw new Error("Font-helper parser source missing");
    await retain(
      `${crate}-${version}/${path}`,
      `https://static.crates.io/crates/${crate}/${crate}-${version}.crate#${checksum}`,
      body,
    );
  }
}

const archive = await readFile(pdfArchive);

if (sha256(archive) !== "51f6c4ff4a71809f00a93356d074816e89afe0dfd4f8fcc6be42e59f63c78365")
  throw new Error("PdfCraft source pin mismatch");

const pdf = readGitSourceArchive(
  archive,
  "pdfcraft-0.17.0",
  "7d78f3e14474b978be014715e0cc64895d77025a",
);

await retain(
  "crates/fonts/Cargo.toml",
  "pdfcraft@7d78f3e14474b978be014715e0cc64895d77025a",
  pdf.get("crates/fonts/Cargo.toml")!,
);

const index = Buffer.from(
  `${JSON.stringify({ schemaVersion: 1, deployable: false, legalOpinion: false, records }, null, 2)}\n`,
);

await writeFile(join(output, "index.json"), index, { flag: "wx" });

console.log(JSON.stringify({ records: records.length, indexSha256: sha256(index) }));
