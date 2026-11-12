import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import acquisition from "../../tooling/artcraft/manifest.json" with { type: "json" };
import redistribution from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import {
  fontNames,
  leadingComments,
  readCrateArchive,
  sha256,
  symphoniaHeaders,
} from "./evidence-bytes.ts";

export type RedistributionManifest = typeof redistribution;

const evidenceRoot = fileURLToPath(new URL("../../tooling/artcraft/", import.meta.url));
const eguiRevision = "6d518fc799681571963842f95b55a6b68431b15a";
const wordcraftPdfRevision = "92d392cff132eaf53e13afff77f38b5c11b73aa0";
const symphoniaRevision = "6d533f26150953a882a6a111ebd13f0abf7129d5";

export const supplement = {
  path: "licenses/REDISTRIBUTION-SUPPLEMENT.md",
  sha256: "54f2e4447b62912b201f2aea18ccfca317955f38b58bd511bbf118ba5af32b2d",
};

function requireEvidence<T>(condition: T, message: string): asserts condition {
  if (!condition) throw new Error(`ArtCraft redistribution evidence: ${message}`);
}

function safePath(path: string): boolean {
  return (
    path.length > 0 &&
    !/[\\:]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
  );
}

const packageSchema = z.object({
  name: z.string(),
  version: z.string(),
  source: z.string().optional(),
  checksum: z.string().optional(),
});

const lockSchema = z.object({ package: z.array(packageSchema) });

const metadataSchema = z.object({
  package: z.object({ name: z.string(), version: z.string(), license: z.string() }),
});

const vcsSchema = z.object({ git: z.object({ sha1: z.string() }), path_in_vcs: z.string() });
const appSchema = z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]);

function lockedPackages(bytes: Buffer): z.infer<typeof packageSchema>[] {
  return lockSchema.parse(Bun.TOML.parse(bytes.toString("utf8"))).package;
}

export function supplementalLegalFiles(data = redistribution) {
  return data.files.filter((file) => file.role === "legal");
}

export async function checkRedistributionEvidence(
  data: RedistributionManifest = redistribution,
  root = evidenceRoot,
): Promise<Map<string, Buffer>> {
  requireEvidence(
    data.schemaVersion === 1 &&
      data.status === "partial-evidence-not-deployment-approval" &&
      data.deployable === false &&
      data.remaining.length >= 4,
    "partial-audit/deployment gates must remain explicit",
  );
  requireEvidence(
    data.eguiRevision === eguiRevision && data.wordcraftPdfRevision === wordcraftPdfRevision,
    "unexpected dependency revision",
  );

  const sources = new Map(data.sources.map((source) => [source.id, source]));
  requireEvidence(sources.size === data.sources.length, "duplicate source id");

  for (const source of sources.values()) {
    requireEvidence(
      /^[a-f0-9]{64}$/.test(source.sha256) &&
        Number.isSafeInteger(source.bytes) &&
        source.bytes > 0 &&
        source.bytes <= 16 * 1024 * 1024,
      `invalid source pin: ${source.id}`,
    );
    requireEvidence(
      source.kind === "raw"
        ? /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[a-f0-9]{40}\/.+/.test(source.url)
        : source.kind === "crate" &&
            /^https:\/\/static\.crates\.io\/crates\/[a-z0-9-]+\/[a-z0-9.-]+\.crate$/.test(
              source.url,
            ),
      `source must be immutable: ${source.id}`,
    );
  }

  const retained = new Map<string, Buffer>();
  const ids = new Map(data.files.map((file) => [file.id, file]));
  requireEvidence(ids.size === data.files.length, "duplicate evidence id");

  const descriptors = [
    ...acquisition.editors.flatMap((editor) => [...editor.legal, ...editor.evidence]),
    ...data.files,
    supplement,
  ];

  for (const file of descriptors) {
    requireEvidence(
      safePath(file.path) && !retained.has(file.path),
      `unsafe/duplicate path: ${file.path}`,
    );
    const bytes = await readFile(join(root, file.path));
    requireEvidence(sha256(bytes) === file.sha256, `checksum mismatch: ${file.path}`);

    if ("bytes" in file)
      requireEvidence(bytes.length === file.bytes, `size mismatch: ${file.path}`);

    retained.set(file.path, bytes);
  }

  for (const file of data.files) {
    const source = sources.get(file.source);
    requireEvidence(source, `missing source: ${file.source}`);
    requireEvidence(
      file.role === "legal"
        ? file.path.startsWith("licenses/")
        : file.role === "evidence" && file.path.startsWith("evidence/"),
      `invalid evidence role: ${file.id}`,
    );
    requireEvidence(
      ["identity", "font-names", "leading-comments", "symphonia-headers"].includes(file.transform),
      `unknown transform: ${file.id}`,
    );

    if (source.kind === "raw" && file.transform === "identity")
      requireEvidence(
        file.sha256 === source.sha256 && file.bytes === source.bytes,
        `raw source mismatch: ${file.id}`,
      );

    if (file.source.startsWith("egui-"))
      requireEvidence(
        source.url.includes(`/egui/${eguiRevision}/`),
        `wrong font revision: ${file.id}`,
      );
  }

  const requireFile = (id: string, legal = true): Buffer => {
    const file = ids.get(id);
    requireEvidence(
      file && (!legal || file.role === "legal"),
      `missing required ${legal ? "legal " : ""}evidence: ${id}`,
    );
    const bytes = retained.get(file.path);
    requireEvidence(bytes, `missing retained bytes: ${id}`);

    return bytes;
  };

  for (const name of ["UFL.txt", "Hack-Regular.txt", "OFL.txt", "emoji-icon-font-mit-license.txt"])
    requireFile(`egui-${name}`);

  for (const [name, copyright] of [
    ["Ubuntu-Light.ttf", "Copyright 2011 Canonical Ltd."],
    ["Hack-Regular.ttf", "Copyright (c) 2018 Source Foundry Authors"],
    ["NotoEmoji-Regular.ttf", "Copyright 2013 Google Inc."],
  ]) {
    requireEvidence(
      requireFile(`egui-${name}`).includes(Buffer.from(copyright!)),
      `missing font copyright: ${name}`,
    );
    requireEvidence(
      ids.get(`egui-${name}`)?.transform === "font-names",
      `wrong font transform: ${name}`,
    );
  }

  for (const editor of acquisition.editors) {
    const app = appSchema.parse(editor.app);
    const source = sources.get(`${app}-lock`);
    requireEvidence(
      source?.url ===
        `https://raw.githubusercontent.com/storytold/${app}/${data.editorCommits[app]}/Cargo.lock`,
      `wrong lockfile provenance: ${app}`,
    );
    const packages = lockedPackages(requireFile(`${app}-lock`, false));

    for (const name of ["egui", "epaint_default_fonts"])
      requireEvidence(
        packages.some((pkg) => pkg.name === name && pkg.source?.endsWith(`#${eguiRevision}`)),
        `incorrect locked egui revision: ${app}/${name}`,
      );

    if (app === "wordcraft") {
      for (const name of ["craft-pdf", "krilla"])
        requireEvidence(
          packages.some(
            (pkg) => pkg.name === name && pkg.source?.endsWith(`#${wordcraftPdfRevision}`),
          ),
          `incorrect locked PDF revision: ${name}`,
        );
    }
  }

  const wordcraft = acquisition.editors.find((editor) => editor.app === "wordcraft")!;

  for (const family of [
    "Inter",
    "JetBrainsMono",
    "SourceSans3",
    "SourceSerif4",
    "noto-sans-georgian",
  ])
    requireEvidence(
      wordcraft.legal.some((file) => file.path.endsWith(`/OFL-${family}.txt`)),
      `missing bundled WordCraft font notice: ${family}`,
    );

  for (const id of [
    "wordcraft-libs-ATTRIBUTION.md",
    "wordcraft-libs-licenses-pdf-writer-LICENSE-ICC.txt",
    "wordcraft-libs-licenses-pdf-writer-LICENSE_APACHE",
    "wordcraft-libs-licenses-pdf-writer-LICENSE_MIT",
  ]) {
    requireFile(id);
    requireEvidence(
      sources.get(id)?.url.includes(`/craft-libs/${wordcraftPdfRevision}/`),
      `wrong PDF source: ${id}`,
    );
  }

  requireEvidence(
    requireFile("polish-hyphenation").includes(Buffer.from("Permission is hereby granted")),
    "missing Polish MIT permission",
  );
  requireFile("hayro-icc-readme");
  requireFile("hayro-icc-cc0");
  requireFile("upstream-icc-readme", false);
  requireEvidence(
    sources.has("hayro-icc-profile") &&
      sources.get("hayro-icc-profile")?.sha256 === sources.get("upstream-icc-profile")?.sha256,
    "Hayro profile does not match the licensed upstream ICC profile",
  );

  const lockedSymphonia = lockedPackages(requireFile("deckcraft-lock", false)).filter((pkg) =>
    /^symphonia(?:-|$)/.test(pkg.name),
  );

  requireEvidence(
    lockedSymphonia.length === 16 &&
      data.symphonia.length === 16 &&
      new Set(data.symphonia.map((pkg) => pkg.name)).size === 16,
    "incomplete locked Symphonia inventory",
  );
  requireFile("symphonia-mpl");

  for (const pkg of data.symphonia) {
    const source = sources.get(pkg.source);
    requireEvidence(source, `missing matching-source archive: ${pkg.source}`);

    const locked = lockedSymphonia.find(
      (item) => item.name === pkg.name && item.version === pkg.version,
    );

    requireEvidence(
      pkg.license === "MPL-2.0" &&
        pkg.version === "0.5.5" &&
        pkg.scope === "locked-candidate-not-target-closure" &&
        pkg.vcsRevision === symphoniaRevision &&
        locked &&
        source?.sha256 === locked.checksum &&
        source.kind === "crate" &&
        source.archiveRoot === `${pkg.name}-${pkg.version}` &&
        source.url ===
          `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
      `incorrect matching-source reference: ${pkg.name}`,
    );

    const metadata = metadataSchema.parse(
      Bun.TOML.parse(requireFile(`${pkg.source}-Cargo.toml`, false).toString()),
    );

    requireEvidence(
      metadata.package.name === pkg.name &&
        metadata.package.version === pkg.version &&
        metadata.package.license === "MPL-2.0",
      `incorrect Symphonia package metadata: ${pkg.name}`,
    );
    requireFile(`${pkg.source}-Cargo.toml.orig`, false);

    const vcs = vcsSchema.parse(
      JSON.parse(requireFile(`${pkg.source}-.cargo_vcs_info.json`, false).toString()),
    );

    requireEvidence(
      vcs.git.sha1 === pkg.vcsRevision && vcs.path_in_vcs === pkg.pathInVcs,
      `incorrect Symphonia VCS provenance: ${pkg.name}`,
    );
    requireEvidence(
      requireFile(`${pkg.source}-copyrights`).includes(Buffer.from("Mozilla Public")),
      `missing MPL source notice: ${pkg.name}`,
    );
  }

  return retained;
}

async function downloadSource(
  source: RedistributionManifest["sources"][number],
  directory: string,
): Promise<Buffer> {
  const response = await fetch(source.url, {
    credentials: "omit",
    signal: AbortSignal.timeout(90_000),
  });

  requireEvidence(
    response.ok && response.body,
    `download failed: ${source.id} HTTP ${response.status}`,
  );
  const file = await open(join(directory, "source"), "wx");
  const reader = response.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;

      received += chunk.value.byteLength;
      requireEvidence(received <= source.bytes, `source exceeds pinned size: ${source.id}`);
      await file.writeFile(chunk.value);
    }
  } finally {
    await reader.cancel();
    await file.close();
  }

  const bytes = await readFile(join(directory, "source"));
  requireEvidence(
    bytes.length === source.bytes && sha256(bytes) === source.sha256,
    `source checksum mismatch: ${source.id}`,
  );

  return bytes;
}

// Re-fetch each immutable input into its own fresh staging directory. Derived notices are
// reproduced in memory, after every archive path/header has been validated. No upstream execution.
export async function verifyRedistributionSources(): Promise<void> {
  await checkRedistributionEvidence();

  for (const source of redistribution.sources) {
    const staging = await mkdtemp(join(tmpdir(), "hyori-artcraft-source-"));

    try {
      const bytes = await downloadSource(source, staging);

      const entries =
        source.kind === "crate" ? readCrateArchive(bytes, source.archiveRoot!) : undefined;

      for (const file of redistribution.files.filter((item) => item.source === source.id)) {
        let derived: Buffer;

        switch (file.transform) {
          case "font-names":
            derived = fontNames(bytes);
            break;
          case "leading-comments":
            derived = leadingComments(bytes);
            break;
          case "symphonia-headers":
            requireEvidence(entries, `missing archive entries: ${file.id}`);
            derived = symphoniaHeaders(entries);
            break;
          case "identity":
            derived = entries ? entries.get(file.member!)! : bytes;
            requireEvidence(derived, `missing archive member: ${file.id}`);
            break;
          default:
            throw new Error(`Unknown evidence transform: ${file.transform}`);
        }

        requireEvidence(
          derived.length === file.bytes && sha256(derived) === file.sha256,
          `reproduced evidence mismatch: ${file.path}`,
        );
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
}

export function symphoniaSourceNotice(data = redistribution): string {
  const lines = [
    "# DeckCraft: Symphonia 0.5.5 matching Source Code Form",
    "",
    "These unmodified source archives match DeckCraft's sixteen locked Symphonia packages by Cargo.lock SHA-256. This inventory is not an exact production wasm32 feature-closure claim. The code is covered by MPL-2.0; see deckcraft/supplement/symphonia/MPL-2.0.txt and the per-file COPYRIGHTS notices. Obtain the corresponding Source Code Form using these direct public archive links. If covered files are modified, also provide the matching modified Source Code Form before distributing the modified executable. The whole Hyori application is not thereby required to use MPL-2.0.",
    "",
    "| Package | Source archive | Bytes | SHA-256 |",
    "| --- | --- | --- | --- |",
  ];

  for (const pkg of data.symphonia) {
    const source = data.sources.find((item) => item.id === pkg.source);
    requireEvidence(source, `missing source: ${pkg.source}`);
    lines.push(
      `| ${pkg.name} ${pkg.version} | [Download](${source.url}) | ${source.bytes} | ${source.sha256} |`,
    );
  }

  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  if (process.argv.slice(2).some((argument) => argument !== "--fetch"))
    throw new Error("Usage: bun scripts/artcraft/redistribution.ts [--fetch]");

  const files = await checkRedistributionEvidence();

  if (process.argv.includes("--fetch")) await verifyRedistributionSources();

  console.log(
    `Verified ${files.size} retained ArtCraft files${process.argv.includes("--fetch") ? " and all 38 immutable source inputs" : " (offline)"}. Production dependency/feature closure and full legal audit remain incomplete; deployable: false.`,
  );
}
