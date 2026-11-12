import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , destination] = process.argv;

if (!destination || process.argv.length !== 3)
  throw new Error("Usage: bun scripts/artcraft/content-font-afm-fetch.ts NEW_PUBLIC_AFM_EVIDENCE");

const output = resolve(destination);

await mkdir(output);

// Same immutable mirror revision as the complete, positively permissive AFM companion readme.
const revision = "f9db3d8c59a8453601ad81514f9c295d6ec050e1";
const records = [];

for (const name of [
  "Helvetica",
  "Helvetica-Bold",
  "Helvetica-Oblique",
  "Helvetica-BoldOblique",
  "Times-Roman",
  "Times-Bold",
  "Times-Italic",
  "Times-BoldItalic",
  "Courier",
  "Courier-Bold",
  "Courier-Oblique",
  "Courier-BoldOblique",
  "Symbol",
  "ZapfDingbats",
]) {
  const url = `https://raw.githubusercontent.com/matplotlib/matplotlib/${revision}/lib/matplotlib/mpl-data/fonts/pdfcorefonts/${name}.afm`;
  const body = await fetchBuildInput(url, undefined, 256 * 1024);
  const path = `${name}.txt`;
  await writeFile(join(output, path), body, { flag: "wx" });
  records.push({ name, path, url, bytes: body.length, sha256: sha256(body) });
}

await writeFile(
  join(output, "sources.json"),
  `${JSON.stringify({ schemaVersion: 1, deployable: false, legalOpinion: false, revision, records }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(
  `Retained ${records.length} AFM data witnesses; no font program or product asset added.`,
);
