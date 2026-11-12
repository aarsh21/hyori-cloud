import { spawnSync } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import acquisition from "../../tooling/artcraft/manifest.json" with { type: "json" };
import redistribution from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import {
  assertNormalTargetTree,
  cargoMetadataSchema,
  hostInclusiveIds,
  parseTargetTree,
  type CargoPackage,
} from "./closure-graph.ts";
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { declaredWebRecipe } from "./closure-recipe.ts";

const repository = fileURLToPath(new URL("../../", import.meta.url));
const commonRevision = "44a7db40b1a3e99eed02c88f89f38cdd6cfffe81";

const runIds = {
  wordcraft: 41339306129,
  gridcraft: 41339254501,
  deckcraft: 41340717822,
  pdfcraft: 41339333094,
};

const appSchema = z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]);

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
  referenced_workflows: z.array(z.object({ path: z.string(), sha: z.string(), ref: z.string() })),
});

const vcsSchema = z.object({
  git: z.object({ sha1: z.string().regex(/^[a-f0-9]{40}$/), dirty: z.boolean().optional() }),
  path_in_vcs: z.string(),
});

const repositorySchema = z.object({ package: z.object({ repository: z.string().optional() }) });

const observationPinSchema = z.object({
  id: z.string(),
  kind: z.string(),
  url: z.string(),
  bytes: z.number(),
  sha256: z.string(),
});

const observationManifestSchema = z.object({ sources: z.array(observationPinSchema) });

type UpstreamArchive = { key: string; entries: Map<string, Buffer> };

export type EvidenceFile = {
  path: string;
  bytes: number;
  sha256: string;
  role: "evidence" | "legal";
  source: string;
  member: string | null;
  transform: "identity" | "copyright-inventory";
};

export type SourcePin = {
  id: string;
  url: string;
  bytes: number;
  sha256: string;
  kind: "editor-archive" | "git-archive" | "crate" | "raw" | "github-run-snapshot";
  root: string | null;
  commit: string | null;
};

export type NoticePackage = {
  id: string;
  name: string;
  version: string;
  source: string | null;
  licenseExpression: string | null;
  sourcePin: string;
  cratePath: string;
  apps: string[];
  files: string[];
  status: "harvested-pending-content-audit" | "blocked";
  gaps: string[];
};

export function copyrightInventory(entries: Map<string, Buffer>, cratePath: string): Buffer {
  const files: { path: string; sha256: string; lines: { line: number; text: string }[] }[] = [];
  const prefix = cratePath ? `${cratePath}/` : "";

  for (const [path, bytes] of [...entries].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    if (
      !path.startsWith(prefix) ||
      !/\.(rs|c|cc|cpp|h|hpp|md|txt|toml|html|xml|json)$/.test(path) ||
      bytes.length > 1024 * 1024
    )
      continue;

    const lines = bytes
      .toString("utf8")
      .split("\n")
      .flatMap((text, index) =>
        /copyright|SPDX-License-Identifier/i.test(text) ? [{ line: index + 1, text }] : [],
      );

    if (lines.length) files.push({ path, sha256: sha256(bytes), lines });
  }

  return Buffer.from(
    `${JSON.stringify({ scope: "textual-copyright-and-SPDX-discovery-not-a-complete-source-or-embedded-asset-audit", files }, null, 2)}\n`,
  );
}

export function noticeMembers(
  entries: Map<string, Buffer>,
  cratePath: string,
  explicitLicense: string | null,
) {
  const prefix = cratePath ? `${cratePath}/` : "";
  const paths = new Set<string>();
  const gaps: string[] = [];
  let licenseBodyCandidateFound = false;

  for (const path of entries.keys()) {
    const name = posix.basename(path);
    const directory = posix.dirname(path);

    const ancestor =
      directory === "." || cratePath === directory || cratePath.startsWith(`${directory}/`);

    const parts = path.split("/");
    const legalDirectory = parts.findIndex((part) => /^licen[cs]es$/i.test(part));
    const owner = parts.slice(0, legalDirectory).join("/");

    const inheritedLegalDirectory =
      legalDirectory >= 0 && (!owner || cratePath === owner || cratePath.startsWith(`${owner}/`));

    const namedNotice =
      /^(?:licen[cs]es?|copying|copyrights?|notices?|authors?|unlicense|attributions?|acknowledg(?:e)?ments?|contributors|third[._-]?party(?:[._-]?(?:notices?|licen[cs]es?))?)(?:[._-]|$)/i.test(
        name,
      ) || /\.licen[cs]e$/i.test(name);

    if (inheritedLegalDirectory || (namedNotice && (path.startsWith(prefix) || ancestor))) {
      paths.add(path);

      if (
        inheritedLegalDirectory ||
        /^(?:licen[cs]es?|copying|copyrights?|unlicense)(?:[._-]|$)/i.test(name)
      )
        licenseBodyCandidateFound = true;
    }
  }

  if (explicitLicense) {
    const path = posix.normalize(posix.join(cratePath, explicitLicense));

    if (path.startsWith("../") || path.startsWith("/") || !entries.has(path))
      gaps.push(`Declared license-file not available within pinned source: ${explicitLicense}`);
    else {
      paths.add(path);
      licenseBodyCandidateFound = true;
    }
  }

  if (!licenseBodyCandidateFound)
    gaps.push(
      "No standalone LICENSE/COPYING/COPYRIGHT body found; notice-only material needs a matching permission text",
    );

  return { paths: [...paths].sort(), gaps, needsLicenseSupplement: !licenseBodyCandidateFound };
}

async function download(
  url: string,
  expectedHash?: string,
  limit = 64 * 1024 * 1024,
): Promise<Buffer> {
  const stage = await mkdtemp(join(tmpdir(), "hyori-artcraft-input-"));

  try {
    const response = await fetch(url, { credentials: "omit", signal: AbortSignal.timeout(90_000) });

    if (!response.ok || !response.body)
      throw new Error(`Source download failed: ${url} HTTP ${response.status}`);

    const reader = response.body.getReader();
    const file = await open(join(stage, "input"), "wx");
    let received = 0;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;

        received += chunk.value.byteLength;

        if (received > limit) throw new Error(`Source size limit exceeded: ${url}`);

        await file.writeFile(chunk.value);
      }
    } finally {
      await reader.cancel();
      await file.close();
    }

    const bytes = await readFile(join(stage, "input"));

    if (expectedHash && sha256(bytes) !== expectedHash)
      throw new Error(`Source checksum mismatch: ${url}`);

    return bytes;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

export type CollectOptions = { output: string; cargo: string; rustc: string; cargoHome: string };

export async function collectClosure(options: CollectOptions): Promise<string> {
  const output = resolve(options.output);

  try {
    await lstat(output);
    throw new Error(`Refusing to overwrite closure evidence: ${output}`);
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
  }

  if (!options.cargo.startsWith("/") || !options.rustc.startsWith("/"))
    throw new Error("Explicit absolute cargo/rustc binaries are required");

  await mkdir(dirname(output), { recursive: true });
  const installation = await mkdtemp(join(dirname(output), ".closure-"));
  const sources: SourcePin[] = [];
  const files: EvidenceFile[] = [];
  const archiveEntries = new Map<string, Map<string, Buffer>>();
  const blockedSources = new Map<string, string>();
  const rawInputs = new Map<string, Buffer>();
  let upstreamArchive: UpstreamArchive | undefined;
  let retainedPins: Map<string, z.infer<typeof observationPinSchema>> | undefined;

  const packageInputs = new Map<
    string,
    {
      pkg: CargoPackage;
      sourcePin: string;
      cratePath: string;
      explicitLicense: string | null;
      apps: Set<string>;
    }
  >();

  const checksums = new Map<string, string>();
  const apps = [];

  const env = {
    ...process.env,
    CARGO_HOME: resolve(options.cargoHome),
    RUSTC: options.rustc,
    RUSTC_WRAPPER: "",
    RUSTC_WORKSPACE_WRAPPER: "",
    CARGO_NET_RETRY: "0",
    CARGO_HTTP_TIMEOUT: "45",
    CARGO_TERM_COLOR: "never",
  };

  const command = (binary: string, args: string[]) => {
    const result = spawnSync(binary, args, {
      cwd: repository,
      env,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      timeout: 180_000,
    });

    return {
      binary,
      args,
      status: result.status,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      error: result.error?.message ?? null,
    };
  };

  const cargoVersion = command(options.cargo, ["--version"]);
  const rustcVersion = command(options.rustc, ["--version", "--verbose"]);

  if (cargoVersion.status !== 0 || rustcVersion.status !== 0)
    throw new Error("Explicit installed Rust toolchain is unavailable");

  async function save(
    path: string,
    bytes: Buffer,
    role: EvidenceFile["role"],
    source: string,
    member: string | null,
    transform: EvidenceFile["transform"] = "identity",
  ) {
    if (
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      /[\\:]/.test(path)
    )
      throw new Error(`Unsafe evidence output path: ${path}`);

    const target = join(installation, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    files.push({
      path,
      bytes: bytes.length,
      sha256: sha256(bytes),
      role,
      source,
      member,
      transform,
    });
  }

  async function pin(
    id: string,
    url: string,
    kind: SourcePin["kind"],
    expectedHash?: string,
    root: string | null = null,
    commit: string | null = null,
  ): Promise<Buffer> {
    const existing = rawInputs.get(id);

    if (existing) return existing;

    let cached: Buffer | undefined;
    const priorPin = sources.find((source) => source.id === id);

    if (priorPin && (priorPin.url !== url || priorPin.kind !== kind))
      throw new Error(`Conflicting source identity: ${id}`);

    if (kind === "github-run-snapshot") {
      if (!retainedPins) {
        retainedPins = new Map();

        try {
          const seedBytes = await readFile(
            join(repository, "tooling/artcraft/closure/manifest.json"),
          );

          if (sha256(seedBytes) !== acquisition.closureEvidence.sha256)
            throw new Error("Retained closure discovery manifest checksum mismatch");

          const seed = observationManifestSchema.parse(JSON.parse(seedBytes.toString("utf8")));
          retainedPins = new Map(seed.sources.map((source) => [source.id, source]));
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
      }

      const observed = retainedPins.get(id);

      if (observed) {
        const app = appSchema.parse(id.replace(/-release-run$/, ""));
        cached = await readFile(
          join(repository, `tooling/artcraft/closure/evidence/${app}/release-run.json`),
        );

        if (
          observed.url !== url ||
          cached.length !== observed.bytes ||
          sha256(cached) !== observed.sha256
        )
          throw new Error(`Retained release observation checksum mismatch: ${id}`);
      }
    }

    if (kind === "crate" && expectedHash) {
      const cache = join(resolve(options.cargoHome), "registry/cache");
      const archiveName = url.slice(url.lastIndexOf("/") + 1);

      for (const directory of await readdir(cache)) {
        const path = join(cache, directory, archiveName);

        try {
          const stat = await lstat(path);

          if (!stat.isFile() || stat.size > 64 * 1024 * 1024)
            throw new Error(`Unsafe/oversized cached crate: ${path}`);

          const staging = await mkdtemp(join(tmpdir(), "hyori-artcraft-cached-crate-"));

          try {
            cached = await readFile(path);
            await writeFile(join(staging, "input.crate"), cached, { flag: "wx" });

            if (sha256(cached) !== expectedHash)
              throw new Error(`Cached crate checksum mismatch: ${path}`);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }

          break;
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT")
            throw error;
        }
      }
    }

    const bytes = cached ?? (await download(url, expectedHash ?? priorPin?.sha256));

    if (!priorPin)
      sources.push({ id, url, kind, bytes: bytes.length, sha256: sha256(bytes), root, commit });

    if (kind === "raw" && bytes.length <= 1024 * 1024) rawInputs.set(id, bytes);

    return bytes;
  }

  try {
    const commonUrl = `https://raw.githubusercontent.com/storytold/craft-common-actions/${commonRevision}/.github/workflows/release.yml`;
    const common = await pin("release-workflow", commonUrl, "raw", undefined, null, commonRevision);
    await save("evidence/common/release.yml", common, "evidence", "release-workflow", null);

    for (const editor of acquisition.editors) {
      const app = appSchema.parse(editor.app);
      const commit = redistribution.editorCommits[app];
      const sourcePin = `${app}-source`;
      const archiveRoot = `${app}-${editor.version}`;

      const bytes = await pin(
        sourcePin,
        editor.sourceUrl,
        "editor-archive",
        editor.sourceSha256,
        archiveRoot,
        commit,
      );

      const entries = readGitSourceArchive(bytes, archiveRoot, commit);
      archiveEntries.set(sourcePin, entries);
      const sourceDirectory = await mkdtemp(join(tmpdir(), `hyori-artcraft-${app}-source-`));

      try {
        // Extract only after the entire pinned archive passes validation. No wrapper,
        // build.rs, Trunk, package script or binary from this directory is executed.
        for (const [path, content] of entries) {
          const target = join(sourceDirectory, path);
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, content, { flag: "wx" });
        }

        const recipePaths = [
          "Cargo.toml",
          "Cargo.lock",
          ".github/workflows/release.yml",
          `apps/${app}-web/Cargo.toml`,
          `apps/${app}-web/Trunk.toml`,
          `apps/${app}-web/index.html`,
          "packaging/web/package.sh",
          app === "deckcraft" ? "packaging/common.sh" : "packaging/env.sh",
          ".cargo/config.toml",
        ];

        for (const [path] of entries) {
          if (path.endsWith("/build.rs")) recipePaths.push(path);
        }

        for (const path of recipePaths) {
          const content = entries.get(path);

          if (content)
            await save(`evidence/${app}/source/${path}`, content, "evidence", sourcePin, path);
        }

        const lock = lockSchema.parse(Bun.TOML.parse(entries.get("Cargo.lock")!.toString()));

        for (const pkg of lock.package) {
          if (pkg.source?.startsWith("registry+") && pkg.checksum) {
            const id = `${pkg.name}@${pkg.version}`;
            const previous = checksums.get(id);

            if (previous && previous !== pkg.checksum)
              throw new Error(`Conflicting registry checksums: ${id}`);

            checksums.set(id, pkg.checksum);
          }
        }

        const runUrl = `https://api.github.com/repos/storytold/${app}/actions/runs/${runIds[app]}`;
        const runBytes = await pin(`${app}-release-run`, runUrl, "github-run-snapshot");
        const run = runSchema.parse(JSON.parse(runBytes.toString()));

        if (
          run.head_sha !== commit ||
          run.conclusion !== "success" ||
          !run.referenced_workflows.some(
            (workflow) =>
              workflow.sha === commonRevision &&
              workflow.path === "storytold/craft-common-actions/.github/workflows/release.yml@main",
          )
        )
          throw new Error(`Release workflow revision not established: ${app}`);

        await save(
          `evidence/${app}/release-run.json`,
          runBytes,
          "evidence",
          `${app}-release-run`,
          null,
        );
        const manifest = join(sourceDirectory, `apps/${app}-web/Cargo.toml`);

        const metadataArgs = [
          "metadata",
          "--manifest-path",
          manifest,
          "--locked",
          "--filter-platform",
          "wasm32-unknown-unknown",
          "--format-version",
          "1",
        ];

        const treeArgs = [
          "tree",
          "--manifest-path",
          manifest,
          "--locked",
          "--target",
          "wasm32-unknown-unknown",
          "-p",
          `${app}-web`,
          "--prefix",
          "depth",
          "--format",
          "{p}\\t{f}\\t{l}",
          "--charset",
          "ascii",
        ];

        const normalize = (text: string) =>
          text
            .replaceAll(sourceDirectory, `<${app}-source>`)
            .replaceAll(resolve(options.cargoHome), "<cargo-home>")
            .replaceAll(repository.replace(/\/$/, ""), "<trusted-repository>");

        const metadataResult = command(options.cargo, metadataArgs);

        const normalResult = command(options.cargo, [
          ...treeArgs,
          "--edges",
          "normal,no-proc-macro",
        ]);

        const hostResult = command(options.cargo, [...treeArgs, "--edges", "normal,build"]);

        const results = [metadataResult, normalResult, hostResult].map((result) => ({
          ...result,
          args: result.args.map(normalize),
          stdout: normalize(result.stdout),
          stderr: normalize(result.stderr),
        }));

        const commandBytes = Buffer.from(
          `${JSON.stringify(
            results.map(({ stdout: _stdout, ...result }) => result),
            null,
            2,
          )}\n`,
        );

        await save(`evidence/${app}/commands.json`, commandBytes, "evidence", "local-cargo", null);

        for (const [index, name] of [
          "metadata.json",
          "normal.tree",
          "host-inclusive.tree",
        ].entries()) {
          await save(
            `evidence/${app}/${name}`,
            Buffer.from(results[index]!.stdout),
            "evidence",
            "local-cargo",
            null,
          );
        }

        const recipe = {
          ...declaredWebRecipe(app, entries),
          releaseRunId: run.id,
          commonWorkflowRevision: commonRevision,
        };

        if (results.some((result) => result.status !== 0)) {
          apps.push({
            app,
            commit,
            recipe,
            status: "blocked",
            blocker: results.filter((result) => result.status !== 0),
            normal: null,
            hostInclusiveIds: [],
            hostOnlyIds: [],
          });
          continue;
        }

        const metadata = cargoMetadataSchema.parse(JSON.parse(results[0]!.stdout));
        const normal = parseTargetTree(results[1]!.stdout, metadata);
        assertNormalTargetTree(normal, metadata);
        const hostIds = hostInclusiveIds(results[2]!.stdout, metadata);
        const normalIds = new Set(normal.packages.map((pkg) => pkg.id));
        apps.push({
          app,
          commit,
          recipe,
          status: "resolved-locked-declared-target-graph",
          blocker: [],
          normal,
          hostInclusiveIds: hostIds,
          hostOnlyIds: hostIds.filter((id) => !normalIds.has(id)),
        });

        for (const id of hostIds) {
          const pkg = metadata.packages.find((item) => item.id === id)!;
          const previous = packageInputs.get(id);

          if (previous) {
            previous.apps.add(app);
            continue;
          }

          let pinId = sourcePin;
          let cratePath: string;

          if (!pkg.source)
            cratePath = posix.dirname(pkg.manifest_path.slice(`<${app}-source>/`.length));
          else if (pkg.source.startsWith("registry+")) {
            pinId = `crate-${pkg.name}-${pkg.version}`;
            cratePath = "";
          } else if (pkg.source.startsWith("git+")) {
            const match = pkg.source.match(
              /^git\+https:\/\/github\.com\/([^/?]+)\/([^/?]+?)(?:\.git)?\?[^#]+#([a-f0-9]{40})$/,
            );

            if (!match) throw new Error(`Unsupported immutable Git source: ${pkg.source}`);

            pinId = `git-${match[1]}-${match[2]}-${match[3]}`;
            const checkout = pkg.manifest_path.split("/git/checkouts/")[1]?.split("/");

            if (!checkout || checkout.length < 3)
              throw new Error(`Unknown Git checkout layout: ${pkg.manifest_path}`);

            cratePath = posix.dirname(checkout.slice(2).join("/"));
          } else throw new Error(`Unsupported package source: ${pkg.source}`);

          if (cratePath === ".") cratePath = "";

          const absoluteLicense = pkg.license_file;

          const explicitLicense = absoluteLicense
            ? posix.relative(posix.dirname(pkg.manifest_path), absoluteLicense)
            : null;

          packageInputs.set(id, {
            pkg,
            sourcePin: pinId,
            cratePath,
            explicitLicense,
            apps: new Set([app]),
          });
        }
      } finally {
        await rm(sourceDirectory, { recursive: true, force: true });
      }
    }

    const notices: NoticePackage[] = [];

    for (const [id, input] of [...packageInputs].sort(([a], [b]) => a.localeCompare(b, "en"))) {
      const { pkg, sourcePin, cratePath, explicitLicense } = input;
      let entries = archiveEntries.get(sourcePin);
      let blocked = blockedSources.get(sourcePin) ?? null;

      if (!entries && !blocked) {
        let bytes: Buffer;
        let root: string;
        let commit: string | null = null;

        if (pkg.source?.startsWith("registry+")) {
          const checksum = checksums.get(`${pkg.name}@${pkg.version}`);

          if (!checksum) throw new Error(`Missing Cargo.lock checksum: ${pkg.name}@${pkg.version}`);

          root = `${pkg.name}-${pkg.version}`;
          bytes = await pin(
            sourcePin,
            `https://static.crates.io/crates/${pkg.name}/${root}.crate`,
            "crate",
            checksum,
            root,
          );
        } else {
          const match = pkg.source!.match(
            /^git\+https:\/\/github\.com\/([^/?]+)\/([^/?]+?)(?:\.git)?\?[^#]+#([a-f0-9]{40})$/,
          )!;

          commit = match[3]!;
          root = `${match[2]}-${commit}`;
          bytes = await pin(
            sourcePin,
            `https://codeload.github.com/${match[1]}/${match[2]}/tar.gz/${commit}`,
            "git-archive",
            undefined,
            root,
            commit,
          );
        }

        try {
          entries = commit
            ? readGitSourceArchive(bytes, root, commit)
            : readCrateArchive(bytes, root);

          if (commit) archiveEntries.set(sourcePin, entries);
        } catch (error) {
          if (!(error instanceof Error)) throw error;

          blocked = error.message;
          blockedSources.set(sourcePin, blocked);
        }
      }

      const key = sha256(Buffer.from(id)).slice(0, 16);
      const prefix = `legal/packages/${pkg.name}-${pkg.version}-${key}`;

      const record: NoticePackage = {
        id,
        name: pkg.name,
        version: pkg.version,
        source: pkg.source,
        licenseExpression: pkg.license,
        sourcePin,
        cratePath,
        apps: [...input.apps].sort(),
        files: [],
        status: entries ? "harvested-pending-content-audit" : "blocked",
        gaps: [],
      };

      if (!entries) record.gaps.push(`Safe source archive reading blocked: ${blocked}`);
      else {
        const harvested = noticeMembers(entries, cratePath, explicitLicense);
        record.gaps.push(...harvested.gaps);

        for (const member of harvested.paths) {
          const path = `${prefix}/${member}`;
          await save(path, entries.get(member)!, "legal", sourcePin, member);
          record.files.push(path);
        }

        const vcsMember = `${cratePath ? `${cratePath}/` : ""}.cargo_vcs_info.json`;
        const vcsBytes = entries.get(vcsMember);

        if (vcsBytes)
          await save(
            `evidence/packages/${pkg.name}-${pkg.version}-${key}/.cargo_vcs_info.json`,
            vcsBytes,
            "evidence",
            sourcePin,
            vcsMember,
          );

        // Some crates.io packages omit their repository-wide licence files. Use only
        // that package's checksummed VCS record, never the repository's current branch.
        if (harvested.needsLicenseSupplement && vcsBytes && pkg.source?.startsWith("registry+")) {
          const vcs = vcsSchema.parse(JSON.parse(vcsBytes.toString()));
          const manifestMember = `${cratePath ? `${cratePath}/` : ""}Cargo.toml`;

          const metadata = repositorySchema.parse(
            Bun.TOML.parse(entries.get(manifestMember)!.toString()),
          );

          const repositoryMatch = metadata.package.repository?.match(
            /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
          );

          if (repositoryMatch && !vcs.git.dirty) {
            const upstream = `${repositoryMatch[1]}/${repositoryMatch[2]}`;
            const key = `${upstream}/${vcs.git.sha1}`;
            const rawPrefix = `https://raw.githubusercontent.com/${key}/`;

            const known = [...(retainedPins?.values() ?? [])].filter(
              (source) => source.kind === "raw" && source.url.startsWith(rawPrefix),
            );

            let candidates: Map<string, Buffer>;

            if (known.length) {
              // Reuse the previously verified discovery index, but re-fetch every legal
              // byte against its immutable URL/hash. GitHub API quota is not a source gate.
              candidates = new Map();

              for (const source of known) {
                const content = await pin(
                  source.id,
                  source.url,
                  "raw",
                  source.sha256,
                  null,
                  vcs.git.sha1,
                );

                candidates.set(source.url.slice(rawPrefix.length), content);
              }
            } else {
              if (upstreamArchive?.key !== key) {
                const archiveRoot = `${repositoryMatch[2]}-${vcs.git.sha1}`;
                const archiveId = `notice-discovery-${sha256(Buffer.from(key)).slice(0, 24)}`;

                const archive = await pin(
                  archiveId,
                  `https://codeload.github.com/${upstream}/tar.gz/${vcs.git.sha1}`,
                  "git-archive",
                  undefined,
                  archiveRoot,
                  vcs.git.sha1,
                );

                upstreamArchive = {
                  key,
                  entries: readGitSourceArchive(archive, archiveRoot, vcs.git.sha1),
                };
              }

              candidates = upstreamArchive.entries;
            }

            const upstreamNotices = noticeMembers(candidates, vcs.path_in_vcs, null);

            for (const member of upstreamNotices.paths) {
              const url = `${rawPrefix}${member}`;
              const sourceId = `upstream-license-${sha256(Buffer.from(url)).slice(0, 24)}`;

              const content = await pin(
                sourceId,
                url,
                "raw",
                sha256(candidates.get(member)!),
                null,
                vcs.git.sha1,
              );

              const path = `${prefix}/UPSTREAM-LICENSES/${member}`;
              await save(path, content, "legal", sourceId, null);
              record.files.push(path);
            }

            if (!upstreamNotices.needsLicenseSupplement) record.gaps = [];
          } else
            record.gaps.push(
              "Missing clean supported-forge VCS provenance for omitted repository licence texts",
            );
        }

        const inventory = `${prefix}/SOURCE-COPYRIGHT-INVENTORY.json`;
        await save(
          inventory,
          copyrightInventory(entries, cratePath),
          "legal",
          sourcePin,
          cratePath,
          "copyright-inventory",
        );
        record.files.push(inventory);
        const member = `${cratePath ? `${cratePath}/` : ""}Cargo.toml`;
        const manifestBytes = entries.get(member);

        if (!manifestBytes) record.gaps.push(`Source package manifest missing: ${member}`);
        else
          await save(
            `evidence/packages/${pkg.name}-${pkg.version}-${key}/Cargo.toml`,
            manifestBytes,
            "evidence",
            sourcePin,
            member,
          );
      }

      record.gaps.push(
        "Content/embedded-material and generated-code notice obligations are not automatically cleared by filename harvesting or SPDX metadata",
      );
      notices.push(record);
    }

    const manifest = {
      schemaVersion: 1,
      status: apps.every((app) => app.status === "resolved-locked-declared-target-graph")
        ? "resolved-declared-graphs-not-full-redistribution-clearance"
        : "blocked-declared-graphs-not-full-redistribution-clearance",
      deployable: false,
      toolchain: {
        cargo: cargoVersion.stdout.trim(),
        rustc: rustcVersion.stdout.trim(),
        cargoBinary: options.cargo,
        rustcBinary: options.rustc,
        trustedCwd: "<trusted-repository>",
        upstreamBuildScriptsExecuted: false,
      },
      proof: {
        declaredTargetGraphsResolved: apps.every(
          (app) => app.status === "resolved-locked-declared-target-graph",
        ),
        exactReleasedBinaryClosureVerified: false,
        matchedNoticeFilesHarvested:
          notices.length > 0 && notices.every((pkg) => pkg.status !== "blocked"),
        fullNoticeAuditComplete: false,
        hostInclusiveNoticesAreConservativeSuperset: true,
      },
      apps,
      sources,
      files: files.sort((a, b) => a.path.localeCompare(b.path, "en")),
      packages: notices,
      remaining: [
        "Release packaging invokes Trunk without --locked; no byte-level link/build attestation proves the shipped binary used exactly the retained lockfile and graph",
        "Review harvested per-package notices, source-only/generated-code and embedded-material obligations; source inventories are discovery evidence, not blanket root-license clearance",
        "Cargo package graphs do not audit Rust std/compiler-builtins or Trunk/wasm-bindgen/Binaryen generated JS/WASM output and dynamically selected build-tool versions",
        "Browser WASM execution and format fidelity",
        "DeckCraft host bridge, reproducible patched build and protected-marks removal",
      ],
    };

    await writeFile(join(installation, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
      flag: "wx",
    });
    await rename(installation, output);

    return join(output, "manifest.json");
  } catch (error) {
    await rm(installation, { recursive: true, force: true });
    throw error;
  }
}

if (import.meta.main) {
  const [, , output, cargo, rustc, cargoHome] = process.argv;

  if (!output || !cargo || !rustc || !cargoHome || process.argv.length !== 6)
    throw new Error(
      "Usage: bun scripts/artcraft/closure-collect.ts OUTPUT ABSOLUTE_CARGO ABSOLUTE_RUSTC CARGO_HOME",
    );

  console.log(await collectClosure({ output, cargo, rustc, cargoHome }));
}
