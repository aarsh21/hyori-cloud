import { readFile, readdir, lstat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { checkContentAudit, contentRoot } from "./content-audit.ts";
import { inspectWasm, discoverSfnt } from "./content-binary.ts";
import { validateZipArchive, expandZipEntry } from "./validated-zip.ts";
import { sha256 } from "./evidence-bytes.ts";

/** Re-check actual pinned distributions, including each claimed exact embedded byte region. */
export async function checkContentArtifacts(configPath: string, root = contentRoot) {
  const config = z
    .object({
      editors: z
        .array(
          z.object({
            app: z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]),
            releaseArchive: z.string(),
          }),
        )
        .length(4),
      modifiedDist: z.string(),
    })
    .parse(JSON.parse(await readFile(configPath, "utf8")));

  if (new Set(config.editors.map((editor) => editor.app)).size !== 4)
    throw new Error("Duplicate/missing official editor");
  const { discovered } = await checkContentAudit(root);

  const expected = new Map(
    discovered.assets.map((asset) => [`${asset.artifact}:${asset.path}`, asset]),
  );

  const seen = new Set<string>();
  let verifiedRegions = 0;

  function verify(artifact: string, path: string, body: Buffer) {
    const key = `${artifact}:${path}`;
    const record = expected.get(key);

    if (!record || record.sha256 !== sha256(body) || record.bytes !== body.length || seen.has(key))
      throw new Error(`Unaccounted or changed distributed member: ${key}`);
    seen.add(key);

    if (record.kind !== "compiled-wasm") return;
    const binary = inspectWasm(body);

    const observed = discovered.binaries.find(
      (binary) => binary.artifact === artifact && binary.path === path,
    );

    if (
      !observed ||
      JSON.stringify(discoverSfnt(binary.memory)) !== JSON.stringify(observed.fonts) ||
      JSON.stringify(binary.producers) !== JSON.stringify(observed.producers)
    )
      throw new Error(`Observed embedded/compiler metadata changed: ${artifact}`);

    for (const reference of discovered.references)
      for (const match of reference.matches) {
        if (match.artifact !== artifact) continue;

        if (match.offset < 0)
          throw new Error("Passive source-byte observation requires separate verification");

        if (
          match.offset + reference.bytes > binary.memory.length ||
          sha256(binary.memory.subarray(match.offset, match.offset + reference.bytes)) !==
            reference.sha256
        )
          throw new Error(`Embedded source bytes changed: ${reference.id}`);
        verifiedRegions += 1;
      }
  }

  for (const editor of config.editors) {
    const pin = official.editors.find((pin) => pin.app === editor.app)!;
    const archive = await readFile(editor.releaseArchive);

    if (sha256(archive) !== pin.sha256 || archive.length !== pin.bytes)
      throw new Error(`Official pin mismatch: ${editor.app}`);

    for (const entry of validateZipArchive(archive, pin.archiveRoot, official.limits))
      if (!entry.directory) verify(`${pin.app}@${pin.version}`, entry.path, expandZipEntry(entry));
  }

  async function modified(relative = "") {
    for (const name of await readdir(join(config.modifiedDist, relative))) {
      const path = join(relative, name);
      const stat = await lstat(join(config.modifiedDist, path));

      if (stat.isSymbolicLink()) throw new Error("Modified artifact link rejected");

      if (stat.isDirectory()) await modified(path);
      else if (stat.isFile())
        verify(
          "deckcraft@0.14.1-hyori-host.1",
          path,
          await readFile(join(config.modifiedDist, path)),
        );
      else throw new Error("Modified artifact special file rejected");
    }
  }

  await modified();

  if (seen.size !== expected.size) throw new Error("An audited distributed member is missing");

  return {
    distributedMembers: seen.size,
    verifiedEmbeddedSourceRegions: verifiedRegions,
    deployable: false,
  };
}

if (import.meta.main) {
  const [, , configPath] = process.argv;

  if (!configPath || process.argv.length !== 3)
    throw new Error("Usage: bun scripts/artcraft/content-artifacts.ts PUBLIC_INPUT_CONFIG");
  console.log(JSON.stringify(await checkContentArtifacts(configPath), null, 2));
}
