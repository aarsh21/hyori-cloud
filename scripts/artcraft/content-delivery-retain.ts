import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { contentRoot } from "./content-audit.ts";
import { contentNoticeFiles } from "./content-notices.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , preview, destination] = process.argv;

if (!preview || !destination || process.argv.length !== 4)
  throw new Error(
    "Usage: bun scripts/artcraft/content-delivery-retain.ts EXISTING_PREVIEW NEW_OUTPUT",
  );

// Adoption is explicit: reproduce from verified evidence, then preserve the existing preview bytes.
const generated = await contentNoticeFiles();
const records = [];

for (const [path, expected] of generated) {
  const body = await readFile(join(resolve(preview), path));

  if (!body.equals(expected))
    throw new Error(`Notice preview differs from retained evidence: ${path}`);
  records.push({ path, bytes: body.length, sha256: sha256(body) });
}

const output = resolve(destination);

await mkdir(output);

for (const record of records) {
  const body = await readFile(join(resolve(preview), record.path));

  if (sha256(body) !== record.sha256) throw new Error("Notice preview changed during adoption");
  await mkdir(dirname(join(output, "files", record.path)), { recursive: true });
  await writeFile(join(output, "files", record.path), body, { flag: "wx" });
}

const index = Buffer.from(
  `${JSON.stringify(
    {
      schemaVersion: 1,
      deployable: false,
      sourceAuditIndexSha256: sha256(await readFile(join(contentRoot, "index.json"))),
      files: records.sort((a, b) => a.path.localeCompare(b.path, "en")),
    },
    null,
    2,
  )}\n`,
);

await writeFile(join(output, "index.json"), index, { flag: "wx" });

console.log(
  JSON.stringify({ files: records.length, indexSha256: sha256(index), deployable: false }),
);
