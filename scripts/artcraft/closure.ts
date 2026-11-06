import { mkdtemp, open, readFile, readdir, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import acquisition from "../../tooling/artcraft/manifest.json" with { type: "json" };
import redistribution from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import { copyrightInventory } from "./closure-collect.ts";
import {
  assertNormalTargetTree,
  cargoMetadataSchema,
  hostInclusiveIds,
  parseTargetTree,
} from "./closure-graph.ts";
import { declaredWebRecipe } from "./closure-recipe.ts";
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";

const closureRoot = fileURLToPath(new URL("../../tooling/artcraft/closure/", import.meta.url));
const appSchema = z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const commit = z.string().regex(/^[a-f0-9]{40}$/);

const fileSchema = z.object({
  path: z.string(),
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
  sha256: digest,
  role: z.enum(["legal", "evidence"]),
  source: z.string(),
  member: z.string().nullable(),
  transform: z.enum(["identity", "copyright-inventory"]),
});

const sourceSchema = z.object({
  id: z.string(),
  url: z.string(),
  bytes: z
    .number()
    .int()
    .positive()
    .max(64 * 1024 * 1024),
  sha256: digest,
  kind: z.enum(["editor-archive", "git-archive", "crate", "raw", "github-run-snapshot"]),
  root: z.string().nullable(),
  commit: commit.nullable(),
});

const treeSchema = z.object({
  packages: z.array(z.object({ id: z.string(), features: z.array(z.string()) })),
  edges: z.array(z.object({ from: z.string(), to: z.string() })),
});

const commandSchema = z.object({
  binary: z.string(),
  args: z.array(z.string()),
  status: z.number().nullable(),
  stderr: z.string(),
  error: z.string().nullable(),
});

const recipeSchema = z.object({
  releaseRunId: z.number().int(),
  commonWorkflowRevision: commit,
  command: z.string(),
  directory: z.string(),
  target: z.literal("wasm32-unknown-unknown"),
  defaultFeatures: z.literal(true),
  additionalFeatures: z.array(z.string()).length(0),
  webCraftFonts: z.boolean(),
  releaseUsesLockedFlag: z.literal(false),
  evidenceStatus: z.literal(
    "tagged-recipe-and-successful-run-reference; no-release-link-attestation",
  ),
});

const packageSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  source: z.string().nullable(),
  licenseExpression: z.string().nullable(),
  sourcePin: z.string(),
  cratePath: z.string(),
  apps: z.array(appSchema),
  files: z.array(z.string()),
  status: z.enum(["harvested-pending-content-audit", "blocked"]),
  gaps: z.array(z.string()).min(1),
});

const appEvidenceSchema = z.object({
  app: appSchema,
  commit,
  recipe: recipeSchema,
  status: z.enum(["resolved-locked-declared-target-graph", "blocked"]),
  blocker: z.array(commandSchema),
  normal: treeSchema.nullable(),
  hostInclusiveIds: z.array(z.string()),
  hostOnlyIds: z.array(z.string()),
});

const closureSchema = z.object({
  schemaVersion: z.literal(1),
  status: z.enum([
    "resolved-declared-graphs-not-full-redistribution-clearance",
    "blocked-declared-graphs-not-full-redistribution-clearance",
  ]),
  deployable: z.literal(false),
  toolchain: z.object({
    cargo: z.string(),
    rustc: z.string(),
    cargoBinary: z.string(),
    rustcBinary: z.string(),
    trustedCwd: z.literal("<trusted-repository>"),
    upstreamBuildScriptsExecuted: z.literal(false),
  }),
  proof: z.object({
    declaredTargetGraphsResolved: z.boolean(),
    exactReleasedBinaryClosureVerified: z.literal(false),
    matchedNoticeFilesHarvested: z.boolean(),
    fullNoticeAuditComplete: z.literal(false),
    hostInclusiveNoticesAreConservativeSuperset: z.literal(true),
  }),
  apps: z.array(appEvidenceSchema).length(4),
  sources: z.array(sourceSchema).max(2000),
  files: z.array(fileSchema).max(10000),
  packages: z.array(packageSchema).max(2000),
  remaining: z.array(z.string()).min(4),
});

const lockSchema = z.object({
  package: z.array(
    z.object({
      name: z.string(),
      version: z.string(),
      source: z.string().optional(),
      checksum: z.string().optional(),
    }),
  ),
});

const runSchema = z.object({
  id: z.number(),
  head_sha: z.string(),
  conclusion: z.string().nullable(),
  referenced_workflows: z.array(z.object({ path: z.string(), sha: z.string() })),
});

const vcsSchema = z.object({
  git: z.object({ sha1: commit, dirty: z.boolean().optional() }),
  path_in_vcs: z.string(),
});

export type ClosureManifest = z.infer<typeof closureSchema>;

export type ClosureFile = z.infer<typeof fileSchema>;

function requireClosure<T>(condition: T, message: string): asserts condition {
  if (!condition) throw new Error(`ArtCraft closure evidence: ${message}`);
}

function safePath(path: string): boolean {
  return (
    !!path &&
    !/[\\:]/.test(path) &&
    ![...path].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    ) &&
    path.split("/").every((part) => part && part !== "." && part !== "..")
  );
}

export async function readClosureManifest(root = closureRoot): Promise<ClosureManifest> {
  const bytes = await readFile(join(root, "manifest.json"));
  requireClosure(
    sha256(bytes) === acquisition.closureEvidence.sha256,
    "closure manifest checksum mismatch",
  );

  return closureSchema.parse(JSON.parse(bytes.toString("utf8")));
}

export async function checkClosureEvidence(input?: ClosureManifest, root = closureRoot) {
  const data = closureSchema.parse(input ?? (await readClosureManifest(root)));
  const descriptors = new Map(data.files.map((file) => [file.path, file]));
  const sources = new Map(data.sources.map((source) => [source.id, source]));
  const packages = new Map(data.packages.map((pkg) => [pkg.id, pkg]));
  requireClosure(
    descriptors.size === data.files.length &&
      sources.size === data.sources.length &&
      packages.size === data.packages.length,
    "duplicate file/source/package identity",
  );
  requireClosure(
    new Set(data.apps.map((app) => app.app)).size === 4,
    "missing or duplicate editor graph",
  );
  requireClosure(
    data.proof.declaredTargetGraphsResolved ===
      data.apps.every((app) => app.status === "resolved-locked-declared-target-graph"),
    "graph-resolution gate contradicts recorded commands",
  );
  requireClosure(
    data.status ===
      (data.proof.declaredTargetGraphsResolved
        ? "resolved-declared-graphs-not-full-redistribution-clearance"
        : "blocked-declared-graphs-not-full-redistribution-clearance"),
    "top-level resolution status contradicts graph gates",
  );
  requireClosure(
    data.proof.matchedNoticeFilesHarvested ===
      (data.packages.length > 0 && data.packages.every((pkg) => pkg.status !== "blocked")),
    "notice-harvest gate contradicts recorded source blockers",
  );
  const expectedPackages = new Set(data.apps.flatMap((app) => app.hostInclusiveIds));
  requireClosure(
    packages.size === expectedPackages.size &&
      [...expectedPackages].every((id) => packages.has(id)),
    "incomplete matched package notice inventory",
  );

  for (const pkg of packages.values()) {
    requireClosure(sources.has(pkg.sourcePin), `missing source pin: ${pkg.id}`);
    requireClosure(
      pkg.apps.join(",") ===
        data.apps
          .filter((app) => app.hostInclusiveIds.includes(pkg.id))
          .map((app) => app.app)
          .sort()
          .join(","),
      `incorrect graph/notice ownership: ${pkg.id}`,
    );

    for (const path of pkg.files)
      requireClosure(
        descriptors.get(path)?.role === "legal",
        `missing matched notice file: ${path}`,
      );

    if (pkg.status !== "blocked")
      requireClosure(
        pkg.files.some((path) => path.endsWith("SOURCE-COPYRIGHT-INVENTORY.json")),
        `missing source-copyright inventory: ${pkg.id}`,
      );
  }

  const retained = new Map<string, Buffer>();

  for (const file of data.files) {
    requireClosure(
      safePath(file.path) && file.path.startsWith(`${file.role}/`),
      `unsafe evidence path: ${file.path}`,
    );
    const stat = await lstat(join(root, file.path));
    requireClosure(
      stat.isFile() && stat.size === file.bytes,
      `invalid evidence file/size: ${file.path}`,
    );
    const bytes = await readFile(join(root, file.path));
    requireClosure(sha256(bytes) === file.sha256, `checksum mismatch: ${file.path}`);
    const source = sources.get(file.source);
    requireClosure(
      source || (file.role === "evidence" && file.source === "local-cargo"),
      `missing file source: ${file.path}`,
    );

    if (source?.kind === "raw" || source?.kind === "github-run-snapshot")
      requireClosure(
        file.transform === "identity" &&
          !file.member &&
          file.sha256 === source.sha256 &&
          file.bytes === source.bytes,
        `raw notice/snapshot mismatch: ${file.path}`,
      );

    if (source && ["crate", "editor-archive", "git-archive"].includes(source.kind)) {
      requireClosure(
        source.root && safePath(source.root) && !source.root.includes("/"),
        `unsafe source archive root: ${source.id}`,
      );
      requireClosure(
        file.member !== null &&
          (safePath(file.member) ||
            (file.transform === "copyright-inventory" && file.member === "")),
        `unsafe/missing source member: ${file.path}`,
      );
    }

    retained.set(file.path, bytes);
  }

  const bytesAt = (path: string): Buffer => {
    const bytes = retained.get(path);
    requireClosure(bytes, `missing required evidence: ${path}`);

    return bytes;
  };

  const locked = new Map<string, string>();

  for (const app of data.apps) {
    const editor = acquisition.editors.find((item) => item.app === app.app)!;
    const archive = sources.get(`${app.app}-source`);
    requireClosure(
      app.commit === redistribution.editorCommits[app.app] &&
        archive?.sha256 === editor.sourceSha256 &&
        archive.commit === app.commit &&
        archive.url === editor.sourceUrl,
      `incorrect immutable editor source: ${app.app}`,
    );
    const originalLock = redistribution.files.find((file) => file.id === `${app.app}-lock`)!;
    const lockBytes = bytesAt(`evidence/${app.app}/source/Cargo.lock`);
    requireClosure(sha256(lockBytes) === originalLock.sha256, `lockfile drift: ${app.app}`);
    const lock = lockSchema.parse(Bun.TOML.parse(lockBytes.toString()));

    for (const pkg of lock.package) {
      if (pkg.source?.startsWith("registry+") && pkg.checksum) {
        const key = `${pkg.name}@${pkg.version}`;
        requireClosure(
          !locked.has(key) || locked.get(key) === pkg.checksum,
          `conflicting checksum: ${key}`,
        );
        locked.set(key, pkg.checksum);
      }
    }

    const recipeFiles = new Map(
      retained
        .entries()
        .filter(([path]) => path.startsWith(`evidence/${app.app}/source/`))
        .map(([path, bytes]) => [path.slice(`evidence/${app.app}/source/`.length), bytes] as const),
    );

    const derivedRecipe = declaredWebRecipe(app.app, recipeFiles);

    for (const key of [
      "command",
      "directory",
      "target",
      "defaultFeatures",
      "webCraftFonts",
      "releaseUsesLockedFlag",
    ] as const)
      requireClosure(
        derivedRecipe[key] === app.recipe[key],
        `build-recipe drift: ${app.app}/${key}`,
      );

    const run = runSchema.parse(
      JSON.parse(bytesAt(`evidence/${app.app}/release-run.json`).toString()),
    );

    requireClosure(
      sources.get(`${app.app}-release-run`)?.url ===
        `https://api.github.com/repos/storytold/${app.app}/actions/runs/${run.id}`,
      `release run observation URL mismatch: ${app.app}`,
    );

    requireClosure(
      run.id === app.recipe.releaseRunId &&
        run.head_sha === app.commit &&
        run.conclusion === "success" &&
        run.referenced_workflows.some(
          (workflow) =>
            workflow.sha === app.recipe.commonWorkflowRevision &&
            workflow.path === "storytold/craft-common-actions/.github/workflows/release.yml@main",
        ),
      `release workflow provenance mismatch: ${app.app}`,
    );
    requireClosure(
      sources.get("release-workflow")?.commit === app.recipe.commonWorkflowRevision,
      `shared workflow revision mismatch: ${app.app}`,
    );

    const commands = z
      .array(commandSchema)
      .length(3)
      .parse(JSON.parse(bytesAt(`evidence/${app.app}/commands.json`).toString()));

    for (const command of commands) {
      requireClosure(
        command.binary === data.toolchain.cargoBinary &&
          command.args.includes("--locked") &&
          command.args.includes("--manifest-path") &&
          command.args.includes(`<${app.app}-source>/apps/${app.app}-web/Cargo.toml`) &&
          command.args.includes("wasm32-unknown-unknown"),
        `unsafe/nonmatching resolution command: ${app.app}`,
      );
      requireClosure(
        !command.args.some((argument) =>
          ["build", "check", "run", "test", "--all-features", "--no-default-features"].includes(
            argument,
          ),
        ),
        `unapproved upstream execution/feature command: ${app.app}`,
      );
    }

    requireClosure(
      commands[0]!.args[0] === "metadata" &&
        commands[0]!.args.includes("--filter-platform") &&
        commands[1]!.args[0] === "tree" &&
        commands[1]!.args.includes("normal,no-proc-macro") &&
        commands[2]!.args.includes("normal,build"),
      `missing target/host graph separation: ${app.app}`,
    );

    if (app.status === "blocked") {
      requireClosure(
        !app.normal && commands.some((command) => command.status !== 0) && app.blocker.length > 0,
        `missing exact resolution blocker: ${app.app}`,
      );
      continue;
    }

    requireClosure(
      commands.every((command) => command.status === 0 && !command.error) &&
        app.blocker.length === 0 &&
        app.normal,
      `unresolved graph advertised as resolved: ${app.app}`,
    );

    const metadata = cargoMetadataSchema.parse(
      JSON.parse(bytesAt(`evidence/${app.app}/metadata.json`).toString()),
    );

    const normal = parseTargetTree(bytesAt(`evidence/${app.app}/normal.tree`).toString(), metadata);
    assertNormalTargetTree(normal, metadata);
    requireClosure(
      JSON.stringify(normal) === JSON.stringify(app.normal),
      `normal dependency/feature graph mismatch: ${app.app}`,
    );

    const hostIds = hostInclusiveIds(
      bytesAt(`evidence/${app.app}/host-inclusive.tree`).toString(),
      metadata,
    );

    requireClosure(
      JSON.stringify(hostIds) === JSON.stringify(app.hostInclusiveIds),
      `host-inclusive graph mismatch: ${app.app}`,
    );
    const normalIds = new Set(normal.packages.map((pkg) => pkg.id));
    requireClosure(
      normal.packages.every((pkg) => hostIds.includes(pkg.id)) &&
        JSON.stringify(hostIds.filter((id) => !normalIds.has(id))) ===
          JSON.stringify(app.hostOnlyIds),
      `host-only classification mismatch: ${app.app}`,
    );

    for (const id of hostIds) {
      const pkg = packages.get(id)!;
      const metadataPackage = metadata.packages.find((candidate) => candidate.id === id)!;
      requireClosure(
        pkg.name === metadataPackage.name &&
          pkg.version === metadataPackage.version &&
          pkg.source === metadataPackage.source &&
          pkg.licenseExpression === metadataPackage.license,
        `package/notice identity mismatch: ${id}`,
      );
    }
  }

  for (const source of sources.values()) {
    if (source.kind === "crate") {
      const pkg = data.packages.find((item) => item.sourcePin === source.id);
      requireClosure(
        pkg &&
          source.root === `${pkg.name}-${pkg.version}` &&
          source.sha256 === locked.get(`${pkg.name}@${pkg.version}`) &&
          source.url ===
            `https://static.crates.io/crates/${pkg.name}/${pkg.name}-${pkg.version}.crate`,
        `registry notice is not lock-matched: ${source.id}`,
      );
    } else if (source.kind === "raw") {
      requireClosure(
        source.commit &&
          (source.url.includes(`/${source.commit}/`) ||
            source.url.includes(`/commit/${source.commit}/`)) &&
          /^https:\/\/(raw\.githubusercontent\.com|codeberg\.org)\//.test(source.url),
        `unversioned licence source: ${source.id}`,
      );
    } else if (source.kind === "git-archive") {
      requireClosure(
        source.commit &&
          /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/tar\.gz\/[a-f0-9]{40}$/.test(
            source.url,
          ) &&
          source.url.endsWith(`/tar.gz/${source.commit}`) &&
          source.root?.endsWith(`-${source.commit}`),
        `unversioned Git archive: ${source.id}`,
      );
    }
  }

  for (const pkg of packages.values()) {
    const source = sources.get(pkg.sourcePin)!;

    if (pkg.source?.startsWith("git+"))
      requireClosure(
        source.kind === "git-archive" && pkg.source.endsWith(`#${source.commit}`),
        `Git notice revision mismatch: ${pkg.id}`,
      );

    const upstreamFiles = pkg.files
      .map((path) => descriptors.get(path)!)
      .filter((file) => file.source !== pkg.sourcePin);

    if (upstreamFiles.length) {
      const vcsFile = data.files.find(
        (file) =>
          file.source === pkg.sourcePin &&
          file.member === `${pkg.cratePath ? `${pkg.cratePath}/` : ""}.cargo_vcs_info.json`,
      );

      requireClosure(vcsFile, `omitted licence lacks checksummed VCS provenance: ${pkg.id}`);
      const vcs = vcsSchema.parse(JSON.parse(bytesAt(vcsFile.path).toString()));
      requireClosure(
        !vcs.git.dirty &&
          upstreamFiles.every((file) => sources.get(file.source)?.commit === vcs.git.sha1),
        `upstream supplement revision mismatch: ${pkg.id}`,
      );
    }
  }

  return { manifest: data, files: retained };
}

async function sourceBytes(
  source: z.infer<typeof sourceSchema>,
  cargoHome?: string,
): Promise<Buffer> {
  const stage = await mkdtemp(join(tmpdir(), "hyori-artcraft-notice-source-"));

  try {
    const path = join(stage, "input");
    let cached: Buffer | undefined;

    if (source.kind === "crate" && cargoHome) {
      const cache = join(cargoHome, "registry/cache");

      for (const directory of await readdir(cache)) {
        const archive = join(cache, directory, source.url.slice(source.url.lastIndexOf("/") + 1));

        try {
          const stat = await lstat(archive);
          requireClosure(
            stat.isFile() && stat.size === source.bytes,
            `cached source size mismatch: ${source.id}`,
          );
          cached = await readFile(archive);
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
      }
    }

    const file = await open(path, "wx");

    try {
      if (cached) await file.writeFile(cached);
      else {
        const response = await fetch(source.url, {
          credentials: "omit",
          signal: AbortSignal.timeout(90_000),
        });

        requireClosure(
          response.ok && response.body,
          `source download failed: ${source.id} HTTP ${response.status}`,
        );
        const reader = response.body.getReader();
        let received = 0;

        try {
          for (;;) {
            const chunk = await reader.read();

            if (chunk.done) break;

            received += chunk.value.byteLength;
            requireClosure(received <= source.bytes, `source exceeds pin: ${source.id}`);
            await file.writeFile(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
      }
    } finally {
      await file.close();
    }

    const bytes = await readFile(path);
    requireClosure(
      bytes.length === source.bytes && sha256(bytes) === source.sha256,
      `source checksum mismatch (or changed run snapshot): ${source.id}`,
    );

    return bytes;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export async function verifyClosureSources(cargoHome?: string): Promise<void> {
  const { manifest } = await checkClosureEvidence();

  for (const source of manifest.sources) {
    // Observed run records are retained snapshots, not immutable remote source files.
    // Their exact local bytes and required provenance fields were checked above.
    if (source.kind === "github-run-snapshot") continue;

    const bytes = await sourceBytes(source, cargoHome);

    const entries =
      source.kind === "crate"
        ? readCrateArchive(bytes, source.root!)
        : ["editor-archive", "git-archive"].includes(source.kind)
          ? readGitSourceArchive(bytes, source.root!, source.commit!)
          : undefined;

    for (const file of manifest.files.filter((candidate) => candidate.source === source.id)) {
      const derived =
        file.transform === "copyright-inventory"
          ? copyrightInventory(entries!, file.member!)
          : entries
            ? entries.get(file.member!)
            : bytes;

      requireClosure(
        derived && derived.length === file.bytes && sha256(derived) === file.sha256,
        `source-derived notice mismatch: ${file.path}`,
      );
    }
  }
}

export function deploymentClosureManifest(data: ClosureManifest) {
  const installedPath = (path: string) => `closure/${path.slice("legal/".length)}`;
  const legal = data.files.filter((file) => file.role === "legal");

  const usedSources = new Set([
    ...data.packages.map((pkg) => pkg.sourcePin),
    ...legal.map((file) => file.source),
  ]);

  return {
    schemaVersion: data.schemaVersion,
    status: data.status,
    deployable: false,
    proof: data.proof,
    toolchain: {
      cargo: data.toolchain.cargo,
      rustc: data.toolchain.rustc,
      upstreamBuildScriptsExecuted: false,
    },
    apps: data.apps.map(({ blocker: _blocker, ...app }) => app),
    sources: data.sources.filter((source) => usedSources.has(source.id)),
    files: legal.map((file) => ({ ...file, path: installedPath(file.path) })),
    packages: data.packages.map((pkg) => ({ ...pkg, files: pkg.files.map(installedPath) })),
    repositoryAuditEvidenceExcluded: true,
    remaining: data.remaining,
  };
}

export function closureNotice(data: ClosureManifest): string {
  const lines = [
    "# ArtCraft declared wasm32 graphs and matched notice corpus",
    "",
    "These packages match the retained locked declared wasm32-unknown-unknown graphs. Target-normal edges exclude proc macros/build dependencies. Host-inclusive notices are an explicitly conservative superset, not evidence those host packages ship in WASM. Package licence expressions and filename/copyright inventories are discovery evidence, not legal clearance. Full content/embedded-material/generated-code audit and exact released-binary linkage remain unverified. All editors remain deployable: false.",
    "",
    "| Editor | Target-normal packages | Host-only packages |",
    "| --- | --- | --- |",
  ];

  for (const app of data.apps)
    lines.push(
      `| ${app.app} | ${app.normal?.packages.length ?? "blocked"} | ${app.hostOnlyIds.length} |`,
    );

  lines.push(
    "",
    "The machine-readable closure.json lists every package, enabled target features, exact source archive/checksum, notice-file hashes, resolution commands and explicit gaps. Per-package files are under closure/packages/. Audit-only source/build/command evidence is retained in the repository, not installed as executable assets.",
    "",
  );

  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  const args = process.argv.slice(2);

  if (args.length && (args[0] !== "--sources" || args.length > 2))
    throw new Error("Usage: bun scripts/artcraft/closure.ts [--sources [CARGO_HOME]]");

  const { manifest, files } = await checkClosureEvidence();

  if (args[0] === "--sources") await verifyClosureSources(args[1]);

  console.log(
    `Verified ${manifest.apps.length} declared wasm32 graphs, ${manifest.packages.length} matched package inventories and ${files.size} retained files${args[0] === "--sources" ? " with source reproduction" : " (offline)"}. Full notice audit and exact released-binary linkage remain unverified; deployable: false.`,
  );
}
