import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256 } from "./evidence-bytes.ts";

const [, , destination] = process.argv;

if (!destination || process.argv.length !== 3)
  throw new Error(
    "Usage: bun scripts/artcraft/content-font-mac-fetch.ts NEW_PUBLIC_MAPPING_EVIDENCE",
  );

const output = resolve(destination);

await mkdir(output);

const url = "https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/ROMAN.TXT";
const body = await fetchBuildInput(url, undefined, 128 * 1024);

await writeFile(join(output, "ROMAN.txt"), body, { flag: "wx" });

await writeFile(
  join(output, "source.json"),
  `${JSON.stringify({ url, bytes: body.length, sha256: sha256(body), scope: "Public mutable publisher snapshot; retain exact bytes, not a claim of immutable publication or legal clearance.", deployable: false }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(JSON.stringify({ bytes: body.length, sha256: sha256(body) }));
