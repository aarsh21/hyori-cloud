import { mkdir, readFile, writeFile, readdir, lstat } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { readClosureManifest } from "./closure.ts";
import { inspectWasm, discoverSfnt, sfntAt } from "./content-binary.ts";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { expandZipEntry, validateZipArchive } from "./validated-zip.ts";
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const configSchema = z.object({
  publicCargoCache: z.string(),
  modifiedDist: z.string(),
  editors: z
    .array(
      z.object({
        app: z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]),
        sourceArchive: z.string(),
        releaseArchive: z.string(),
      }),
    )
    .length(4),
});

const [, , configPath, destination] = process.argv;

if (!configPath || !destination || process.argv.length !== 4)
  throw new Error("Usage: bun scripts/artcraft/content-discover.ts PUBLIC_INPUT_CONFIG NEW_OUTPUT");

const config = configSchema.parse(JSON.parse(await readFile(configPath, "utf8")));
const output = resolve(destination);

await mkdir(output);

const closure = await readClosureManifest();

const assets: {
  artifact: string;
  path: string;
  bytes: number;
  sha256: string;
  kind: string;
  inlineText?: string;
}[] = [];

const binaries: {
  artifact: string;
  path: string;
  inspection: ReturnType<typeof inspectWasm>;
  fonts: ReturnType<typeof discoverSfnt>;
}[] = [];

const references: {
  id: string;
  source: string;
  member: string;
  sha256: string;
  kind: string;
  bytes: number;
  matches: { artifact: string; offset: number }[];
  font?: ReturnType<typeof sfntAt>;
  header?: string;
}[] = [];

const sites: {
  source: string;
  member: string;
  line: number;
  expression: string;
  resolved: string | null;
}[] = [];

const sourceRecords: { id: string; url: string; sha256: string; bytes: number }[] = [];
const matchedByHash = new Map<string, { artifact: string; offset: number }[]>();

async function asset(artifact: string, path: string, bytes: Buffer) {
  let kind = "unclassified";

  if (path.endsWith(".wasm")) kind = "compiled-wasm";
  else if (path.endsWith(".js")) kind = "javascript";
  else if (path.endsWith(".html")) kind = "html-with-inline-style-and-loader";
  else if (path.endsWith(".ico")) kind = "application-icon";
  else if (/LICENSE|OFL|NOTICE|ATTRIBUTION/.test(path)) kind = "notice-document";
  else if (path.endsWith(".md")) kind = "documentation";
  else if (["_headers", ".htaccess"].includes(path)) kind = "hosting-configuration";

  const record: (typeof assets)[number] = {
    artifact,
    path,
    bytes: bytes.length,
    sha256: sha256(bytes),
    kind,
  };

  if (
    [
      "javascript",
      "html-with-inline-style-and-loader",
      "notice-document",
      "hosting-configuration",
    ].includes(kind)
  )
    record.inlineText = bytes.toString();
  assets.push(record);

  if (kind === "compiled-wasm") {
    const inspection = inspectWasm(bytes);
    binaries.push({ artifact, path, inspection, fonts: discoverSfnt(inspection.memory) });
  }
}

for (const entry of config.editors) {
  const pin = official.editors.find((editor) => editor.app === entry.app)!;
  const archive = await readFile(entry.releaseArchive);

  if (archive.length !== pin.bytes || sha256(archive) !== pin.sha256)
    throw new Error(`Official release checksum mismatch: ${entry.app}`);
  sourceRecords.push({
    id: `${entry.app}-distribution`,
    url: pin.url,
    bytes: archive.length,
    sha256: sha256(archive),
  });

  for (const file of validateZipArchive(archive, pin.archiveRoot, official.limits))
    if (!file.directory)
      await asset(`${entry.app}@${pin.version}`, file.path, expandZipEntry(file));
}

async function modified(relative = "") {
  for (const name of await readdir(join(config.modifiedDist, relative))) {
    const path = join(relative, name);
    const info = await lstat(join(config.modifiedDist, path));

    if (info.isSymbolicLink()) throw new Error("Modified artifact link rejected");

    if (info.isDirectory()) await modified(path);
    else if (info.isFile())
      await asset(
        "deckcraft@0.14.1-hyori-host.1",
        path,
        await readFile(join(config.modifiedDist, path)),
      );
    else throw new Error("Modified artifact special file rejected");
  }
}

await modified();

const modifiedWasm = assets.find(
  (file) => file.artifact === "deckcraft@0.14.1-hyori-host.1" && file.kind === "compiled-wasm",
);

if (modifiedWasm?.sha256 !== "f472a886c58d7a0fd93dbb6017bbfc7b670e8676bd776c801b489dbca38b2e13")
  throw new Error("Modified WASM no longer matches retained build");

await writeFile(
  join(output, "binary-discovery.json"),
  JSON.stringify(
    binaries.map(({ artifact, path, inspection, fonts }) => ({
      artifact,
      path,
      producers: inspection.producers,
      rustSourceCommits: inspection.rustSourceCommits,
      dataSegments: inspection.segments.length,
      fonts,
    })),
    null,
    2,
  ),
  { flag: "wx" },
);

function observe(source: string, member: string, bytes: Buffer, kind: string) {
  const hash = sha256(bytes);
  let matches = matchedByHash.get(hash);

  if (!matches) {
    matches = [];

    if (bytes.length >= 64)
      for (const binary of binaries) {
        const offset = binary.inspection.memory.indexOf(bytes);

        if (offset >= 0) matches.push({ artifact: binary.artifact, offset });

        // Passive data segments have no statically reconstructed address.
        if (
          offset < 0 &&
          binary.inspection.segments.some(
            (segment) => segment.offset === null && segment.bytes.indexOf(bytes) >= 0,
          )
        )
          matches.push({ artifact: binary.artifact, offset: -1 });
      }

    matchedByHash.set(hash, matches);
  }

  const font = /\.(?:ttf|otf)$/i.test(member) ? sfntAt(bytes, 0) : undefined;

  const header =
    bytes.length < 2 * 1024 * 1024 &&
    /\.(?:rs|txt|pat|dic|md|wgsl|glsl|c|h|cpp|json)$/i.test(member)
      ? bytes.subarray(0, 12000).toString("utf8")
      : undefined;

  const reference: (typeof references)[number] = {
    id: `${source}:${member}`,
    source,
    member,
    bytes: bytes.length,
    sha256: hash,
    kind,
    matches,
  };

  if (font) reference.font = font;

  if (header) reference.header = header;
  references.push(reference);
}

for (const source of closure.sources.filter((source) =>
  ["editor-archive", "git-archive", "crate"].includes(source.kind),
)) {
  const packages = closure.packages.filter((pkg) => pkg.sourcePin === source.id);

  if (!packages.length) continue;
  let archive: Buffer;
  const app = config.editors.find((entry) => `${entry.app}-source` === source.id);

  if (app) archive = await readFile(app.sourceArchive);
  else if (source.kind === "crate") {
    const packageName = packages[0]!;

    try {
      archive = await readFile(
        join(
          config.publicCargoCache,
          "registry/cache/index.crates.io-1949cf8c6b5b557f",
          `${packageName.name}-${packageName.version}.crate`,
        ),
      );
    } catch {
      archive = await fetchBuildInput(source.url, source.sha256, 64 * 1024 * 1024);
    }
  } else archive = await fetchBuildInput(source.url, source.sha256, 64 * 1024 * 1024);

  if (sha256(archive) !== source.sha256) throw new Error(`Pinned source mismatch: ${source.id}`);

  const files =
    source.kind === "crate"
      ? readCrateArchive(archive, source.root!)
      : readGitSourceArchive(archive, source.root!, source.commit!);

  sourceRecords.push({
    id: source.id,
    url: source.url,
    bytes: archive.length,
    sha256: sha256(archive),
  });
  const observed = new Set<string>();

  for (const [member, bytes] of files) {
    const isTest =
      /(?:^|\/)(?:tests?|testdata|fixtures|examples|benches|screenshots)(?:\/|\.)/.test(member);

    if (
      !isTest &&
      /\.(?:ttf|otf|ttc|woff2?|pfb|icc|icm|bcmap|postcard|blob|dic|pat|aff|wgsl|glsl)$/i.test(
        member,
      )
    ) {
      observe(source.id, member, bytes, "resource-file");
      observed.add(member);
    }

    if (!member.endsWith(".rs") || isTest) continue;
    const text = bytes.toString();

    for (const match of text.matchAll(/include_(?:bytes|str)!\s*\(\s*"([^"\n]+)"\s*\)/g)) {
      const target = posix.normalize(posix.join(posix.dirname(member), match[1]!));
      sites.push({
        source: source.id,
        member,
        line: text.slice(0, match.index).split("\n").length,
        expression: match[0],
        resolved: files.has(target) ? target : null,
      });

      if (files.has(target) && !observed.has(target)) {
        observe(source.id, target, files.get(target)!, "literal-include");
        observed.add(target);
      }
    }

    for (const match of text.matchAll(/include(?:_bytes|_str)?!\s*\(\s*concat!\([^;]{0,1500}/g))
      sites.push({
        source: source.id,
        member,
        line: text.slice(0, match.index).split("\n").length,
        expression: match[0].slice(0, 1500),
        resolved: null,
      });

    if (
      /automatically generated|auto-generated|DO NOT EDIT|generated (?:from|by)|Unicode.*(?:data|license)|WHATWG|Adobe.*(?:copyright|Copyright)/i.test(
        text.slice(0, 8000),
      ) &&
      !observed.has(member)
    ) {
      observe(source.id, member, bytes, "generated-or-attributed-source");
      observed.add(member);
    }
  }
}

const result = {
  schemaVersion: 1,
  deployable: false,
  fullNoticeAuditComplete: false,
  method:
    "Static ZIP/source/WASM-data and sfnt parsing; no WASM instantiation, no source build, no claim of exhaustive binary decompilation. Source candidates without exact matches are not asserted absent.",
  sources: sourceRecords,
  assets,
  binaries: binaries.map(({ artifact, path, inspection, fonts }) => ({
    artifact,
    path,
    sections: inspection.sections,
    producers: inspection.producers,
    rustSourceCommits: inspection.rustSourceCommits,
    segments: inspection.segments.map((segment) => ({
      offset: segment.offset,
      bytes: segment.bytes.length,
      sha256: sha256(segment.bytes),
    })),
    fonts,
  })),
  references,
  sites,
};

await writeFile(join(output, "discovery.json"), `${JSON.stringify(result, null, 2)}\n`, {
  flag: "wx",
});

console.log(
  JSON.stringify(
    {
      assets: assets.length,
      binaries: binaries.map((binary) => ({
        artifact: binary.artifact,
        fonts: binary.fonts.map((font) => font.names.filter((name) => [1, 2, 0].includes(name.id))),
        rust: binary.inspection.rustSourceCommits,
        producers: binary.inspection.producers,
      })),
      references: references.length,
      matchedReferences: references.filter((reference) => reference.matches.length).length,
      includeSites: sites.length,
    },
    null,
    2,
  ),
);
