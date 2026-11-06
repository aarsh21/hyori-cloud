import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256 } from "./evidence-bytes.ts";

const requestsSchema = z
  .array(
    z.object({
      id: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      url: z
        .url()
        .refine(
          (value) =>
            value.startsWith("https://raw.githubusercontent.com/") ||
            value.startsWith("https://www.unicode.org/Public/"),
        ),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
    }),
  )
  .max(100);

const [, , requestPath, destination] = process.argv;

if (!requestPath || !destination || process.argv.length !== 4)
  throw new Error("Usage: bun scripts/artcraft/content-extra-fetch.ts PUBLIC_REQUESTS NEW_OUTPUT");

const requests = requestsSchema.parse(JSON.parse(await readFile(requestPath, "utf8")));
const output = resolve(destination);

await mkdir(output);

const files: { id: string; path: string; url: string; bytes: number; sha256: string }[] = [];
const failures: { id: string; url: string; error: string }[] = [];

for (const request of requests) {
  try {
    const bytes = await fetchBuildInput(request.url, request.sha256, 8 * 1024 * 1024);
    const path = `${request.id}.source`;
    await writeFile(join(output, path), bytes, { flag: "wx" });
    files.push({
      id: request.id,
      path,
      url: request.url,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  } catch (error) {
    failures.push({ id: request.id, url: request.url, error: String(error) });
  }
}

await writeFile(
  join(output, "sources.json"),
  `${JSON.stringify({ schemaVersion: 1, files, failures }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(JSON.stringify({ files: files.length, failures }, null, 2));
