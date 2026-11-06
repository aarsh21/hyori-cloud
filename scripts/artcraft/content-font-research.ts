import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , destination] = process.argv;

if (!destination || process.argv.length !== 3)
  throw new Error("Usage: bun scripts/artcraft/content-font-research.ts NEW_PUBLIC_SOURCE_OUTPUT");

const output = resolve(destination);

await mkdir(output);

const records: { id: string; path: string; url: string; bytes: number; sha256: string }[] = [];
const failures: { id: string; url: string; error: string }[] = [];

async function retain(id: string, url: string) {
  try {
    const body = await fetchBuildInput(url, undefined, 2 * 1024 * 1024);
    const path = `${records.length}.txt`;
    await writeFile(join(output, path), body, { flag: "wx" });
    records.push({ id, path, url, bytes: body.length, sha256: sha256(body) });

    return body;
  } catch (error) {
    failures.push({
      id,
      url,
      error: error instanceof Error ? error.message : "Public fetch failed",
    });

    return undefined;
  }
}

for (const repo of ["chromium/pdfium", "matplotlib/matplotlib"]) {
  const snapshot = await retain(
    `${repo}:commit-observation`,
    `https://api.github.com/repos/${repo}/commits/HEAD`,
  );

  if (!snapshot) continue;

  const { sha } = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/) })
    .parse(JSON.parse(snapshot.toString()));

  const paths =
    repo === "chromium/pdfium"
      ? [
          "LICENSE",
          "AUTHORS",
          "core/fpdfapi/font/cpdf_fontencoding.cpp",
          "core/fpdfapi/font/cpdf_fontencoding.h",
          "core/fxge/fx_font.cpp",
        ]
      : [
          "lib/matplotlib/mpl-data/fonts/pdfcorefonts/readme.txt",
          "lib/matplotlib/mpl-data/fonts/pdfcorefonts/Helvetica.afm",
        ];

  for (const path of paths)
    await retain(`${repo}:${path}`, `https://raw.githubusercontent.com/${repo}/${sha}/${path}`);
}

await retain(
  "adobe-agl-glyphlist",
  "https://raw.githubusercontent.com/adobe-type-tools/agl-aglfn/4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6/glyphlist.txt",
);

await writeFile(
  join(output, "sources.json"),
  `${JSON.stringify({ schemaVersion: 1, deployable: false, legalOpinion: false, records, failures }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(JSON.stringify({ records: records.length, failures }, null, 2));
