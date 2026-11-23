/**
 * Measures how far the native host v3 fork sits from upstream ArtCraft. For each editor it
 * composes the fork on its pinned tag, stage by stage, then against a newer upstream tag:
 *
 * - whether the real composer still applies there (it fails closed on the first missing anchor);
 * - a three-way merge of every upstream file the fork edits (base: pinned tag, ours: composed
 *   fork, theirs: newer tag), counting conflicting hunks and lines, which the composer cannot
 *   report past its first failure;
 * - the fork's size per stage, split into host protocol, theming, branding and polish.
 *
 * Textual success is not a build: authored Rust modules can still fail to compile against a newer
 * upstream API. Network: `git ls-remote` and codeload archive downloads only; nothing is executed.
 *
 *   bun scripts/artcraft/native-v3-drift.ts [--cache DIR] [--json FILE]
 *     [--candidate | --target APP=vX.Y.Z...] [--fail-on-drift]
 *
 * Exit 1 when a pinned tag no longer composes or has moved; with --fail-on-drift, exit 2 when a
 * target tag does not compose or conflicts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import candidate from "../../tooling/artcraft/upstream-candidate.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import {
  composeNativeSource,
  nativeApps,
  nativeAuthoredInputs,
  nativeSourceCommits,
  readPinnedSource,
} from "./native-v3-source.ts";
import type { NativeApp } from "./native-v3-source.ts";

/** Which part of the fork each composition stage belongs to. */
const area = new Map([
  ["deck-host-engine-base", "host protocol"],
  ["direct-native-methods", "host protocol"],
  ["app-native-hookup", "host protocol"],
  ["shared-native-frame", "host protocol"],
  ["hyori-chrome-palette", "theming"],
  ["marks-removed", "branding"],
  ["hyori-host-polish", "polish"],
]);

type LineStat = { files: number; added: number; removed: number };

export type MergeResult =
  | { status: "clean" | "upstream-unchanged" }
  | { status: "conflict"; hunks: number; lines: number }
  | { status: "removed-upstream"; lines: number };

/** Runs `run` on temporary copies of `bodies`, removed afterwards. */
async function withFiles<T>(bodies: Buffer[], run: (paths: string[]) => T): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), "hyori-artcraft-drift-"));

  try {
    const paths = bodies.map((_, index) => join(directory, String(index)));
    await Promise.all(bodies.map((body, index) => writeFile(paths[index]!, body)));

    return run(paths);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Lines added and removed between two versions of one file, as `git diff` counts them. */
export async function lineDelta(before: Buffer | undefined, after: Buffer | undefined) {
  if (before !== undefined && after !== undefined && before.equals(after))
    return { added: 0, removed: 0 };

  const diff = await withFiles([before ?? Buffer.alloc(0), after ?? Buffer.alloc(0)], ([a, b]) =>
    spawnSync("git", ["diff", "--no-index", "--numstat", "--no-renames", a!, b!], {
      encoding: "utf8",
    }),
  );

  if (diff.status !== 0 && diff.status !== 1) throw new Error(`git diff failed: ${diff.stderr}`);
  const [added = "0", removed = "0"] = diff.stdout.split("\t");

  // Binary files report "-": count them as one changed unit each way.
  return {
    added: added === "-" ? 1 : Number(added),
    removed: removed === "-" ? 1 : Number(removed),
  };
}

/** Three-way merges one fork-edited file onto a newer upstream version of it. */
export async function mergeOnto(
  base: Buffer,
  ours: Buffer,
  theirs: Buffer | undefined,
): Promise<MergeResult> {
  if (theirs === undefined) {
    const { added, removed } = await lineDelta(base, ours);

    return { status: "removed-upstream", lines: added + removed };
  }

  if (theirs.equals(base)) return { status: "upstream-unchanged" };

  const merge = await withFiles([ours, base, theirs], (paths) =>
    spawnSync("git", ["merge-file", "-p", ...paths], { maxBuffer: 256 * 1024 * 1024 }),
  );

  // Exit status is the conflict count, capped at 127; a negative or signal status is an error.
  if (merge.status === null || merge.status > 127 || merge.error)
    throw new Error(`git merge-file failed: ${merge.stderr?.toString()}`);

  if (merge.status === 0) return { status: "clean" };
  let hunks = 0;
  let lines = 0;
  let inside = false;

  for (const line of merge.stdout.toString().split("\n")) {
    if (line.startsWith("<<<<<<< ")) {
      hunks += 1;
      inside = true;
    } else if (line.startsWith(">>>>>>> ")) inside = false;
    else if (inside && line !== "=======") lines += 1;
  }

  return { status: "conflict", hunks, lines };
}

function upstreamTags(app: NativeApp) {
  const listing = execFileSync(
    "git",
    ["ls-remote", "--tags", `https://github.com/storytold/${app}`],
    { encoding: "utf8", timeout: 60_000 },
  );

  const tags = new Map<string, string>();

  for (const line of listing.trim().split("\n")) {
    const [commit, ref] = line.split("\t");
    const name = ref?.replace(/^refs\/tags\//, "");

    if (!commit || !name) continue;

    // Annotated tags list the tag object, then the commit it points at under `^{}`.
    if (name.endsWith("^{}")) tags.set(name.slice(0, -3), commit);
    else if (!tags.has(name)) tags.set(name, commit);
  }

  return tags;
}

function semver(tag: string) {
  const match = /^v(\d+)\.(\d+)\.(\d+)$/.exec(tag);

  return match ? match.slice(1).map(Number) : null;
}

function newest(tags: Iterable<string>) {
  return [...tags]
    .filter((tag) => semver(tag) !== null)
    .sort((a, b) => {
      const [x, y] = [semver(a)!, semver(b)!];

      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    })
    .at(-1);
}

async function archive(cache: string, app: NativeApp, tag: string) {
  const path = join(cache, `${app}-${tag}.tar.gz`);

  if (!existsSync(path)) {
    const response = await fetch(
      `https://codeload.github.com/storytold/${app}/tar.gz/refs/tags/${tag}`,
    );

    if (!response.ok) throw new Error(`${app} ${tag} archive: HTTP ${response.status}`);
    await writeFile(path, Buffer.from(await response.arrayBuffer()));
  }

  return readFile(path);
}

function changedPaths(before: ReadonlyMap<string, Buffer>, after: ReadonlyMap<string, Buffer>) {
  const paths = new Set<string>();

  for (const [path, body] of after) if (!before.get(path)?.equals(body)) paths.add(path);

  for (const path of before.keys()) if (!after.has(path)) paths.add(path);

  return [...paths].sort();
}

async function stat(
  before: ReadonlyMap<string, Buffer>,
  after: ReadonlyMap<string, Buffer>,
  paths: readonly string[],
): Promise<LineStat> {
  const total = { files: paths.length, added: 0, removed: 0 };

  for (const path of paths) {
    const delta = await lineDelta(before.get(path), after.get(path));
    total.added += delta.added;
    total.removed += delta.removed;
  }

  return total;
}

async function measure(
  app: NativeApp,
  cache: string,
  target: string | undefined,
  useCandidate: boolean,
) {
  const pin = official.editors.find((editor) => editor.app === app)!;
  const pinnedTag = `v${pin.version}`;
  const tags = upstreamTags(app);
  const pinnedCommit = tags.get(pinnedTag);
  const upgrade = useCandidate ? candidate.editors.find((editor) => editor.app === app) : undefined;

  if (useCandidate && upgrade === undefined) throw new Error(`${app} has no recorded candidate`);

  const targetTag =
    upgrade === undefined ? (target ?? newest(tags.keys())!) : `v${upgrade.version}`;

  const targetCommit = tags.get(targetTag);

  if (pinnedCommit !== nativeSourceCommits[app])
    throw new Error(
      `${app} ${pinnedTag} now points at ${pinnedCommit ?? "nothing"}, not the pinned ${nativeSourceCommits[app]}`,
    );

  if (targetCommit === undefined) throw new Error(`${app} has no upstream tag ${targetTag}`);

  if (upgrade !== undefined && targetCommit !== upgrade.commit)
    throw new Error(`${app} ${targetTag} no longer points at candidate commit ${upgrade.commit}`);

  const targetArchive = await archive(cache, app, targetTag);

  if (upgrade !== undefined && sha256(targetArchive) !== upgrade.sourceSha256)
    throw new Error(`${app} ${targetTag} candidate source checksum mismatch`);

  const authored = await nativeAuthoredInputs();
  const { original } = readPinnedSource(app, await archive(cache, app, pinnedTag));
  const stages: { stage: string; area: string; lines: LineStat }[] = [];
  const touchedBy = new Map<string, string[]>();
  let previous: ReadonlyMap<string, Buffer> = original;
  const snapshots: { stage: string; files: ReadonlyMap<string, Buffer> }[] = [];

  const composed = await composeNativeSource(app, original, authored, (stage, files) =>
    snapshots.push({ stage, files: new Map(files) }),
  );

  for (const { stage, files } of snapshots) {
    const paths = changedPaths(previous, files);

    for (const path of paths) touchedBy.set(path, [...(touchedBy.get(path) ?? []), stage]);
    stages.push({
      stage,
      area: area.get(stage) ?? "other",
      lines: await stat(previous, files, paths),
    });
    previous = files;
  }

  const upstream = readGitSourceArchive(
    targetArchive,
    `${app}-${targetTag.slice(1)}`,
    targetCommit,
  );

  let failure: { afterStage: string; error: string } | null = null;
  let lastStage = "none";

  try {
    await composeNativeSource(app, upstream, authored, (stage) => {
      lastStage = stage;
    });
  } catch (error) {
    failure = {
      afterStage: lastStage,
      error: (error instanceof Error ? error.message : String(error)).split("\n")[0]!.slice(0, 400),
    };
  }

  const files: {
    path: string;
    stages: string[];
    merge: MergeResult | { status: "path-taken-upstream" };
    upstream: { added: number; removed: number };
  }[] = [];

  for (const change of composed.changes) {
    const base = original.get(change.path);
    const ours = composed.files.get(change.path)!;
    const theirs = upstream.get(change.path);
    const stagesFor = touchedBy.get(change.path) ?? [];

    if (base === undefined) {
      // Added by the fork: textually clean unless upstream created the same path.
      files.push({
        path: change.path,
        stages: stagesFor,
        merge: theirs === undefined ? { status: "clean" } : { status: "path-taken-upstream" },
        upstream: { added: 0, removed: 0 },
      });
      continue;
    }

    files.push({
      path: change.path,
      stages: stagesFor,
      merge: await mergeOnto(base, ours, theirs),
      upstream: await lineDelta(base, theirs),
    });
  }

  const upstreamChanged = changedPaths(original, upstream);

  return {
    app,
    pinned: { tag: pinnedTag, commit: pinnedCommit },
    target: { tag: targetTag, commit: targetCommit },
    releasesBehind: [...tags.keys()].filter((tag) => {
      const [x, p, t] = [semver(tag), semver(pinnedTag)!, semver(targetTag)!];

      return x !== null && compare(x, p) > 0 && compare(x, t) <= 0;
    }).length,
    stages,
    forkEditsUpstreamFiles: files.filter((file) => original.has(file.path)).length,
    forkAddsFiles: files.filter((file) => !original.has(file.path)).length,
    targetComposes: failure === null,
    failure,
    conflicts: files.filter(
      (file) =>
        file.merge.status === "conflict" ||
        file.merge.status === "removed-upstream" ||
        file.merge.status === "path-taken-upstream",
    ),
    conflictHunks: files.reduce(
      (sum, file) => sum + (file.merge.status === "conflict" ? file.merge.hunks : 0),
      0,
    ),
    conflictLines: files.reduce(
      (sum, file) =>
        sum +
        (file.merge.status === "conflict" || file.merge.status === "removed-upstream"
          ? file.merge.lines
          : 0),
      0,
    ),
    forkFilesChangedUpstream: files.filter(
      (file) => original.has(file.path) && file.merge.status !== "upstream-unchanged",
    ).length,
    upstreamFilesChanged: upstreamChanged.length,
    upstreamRustFilesChanged: upstreamChanged.filter((path) => path.endsWith(".rs")).length,
    cargoLockChanged: !original
      .get("Cargo.lock")
      ?.equals(upstream.get("Cargo.lock") ?? Buffer.alloc(0)),
    files,
  };
}

function compare(x: number[], y: number[]) {
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
}

function markdown(reports: Awaited<ReturnType<typeof measure>>[]) {
  const rows = reports.map((report) => {
    const protocol = report.stages
      .filter((stage) => stage.area === "host protocol")
      .reduce((sum, stage) => sum + stage.lines.added + stage.lines.removed, 0);

    const other = report.stages
      .filter((stage) => stage.area !== "host protocol")
      .reduce((sum, stage) => sum + stage.lines.added + stage.lines.removed, 0);

    return `| ${report.app} | ${report.pinned.tag} → ${report.target.tag} (${report.releasesBehind}) | ${report.forkEditsUpstreamFiles} + ${report.forkAddsFiles} new | ${protocol} / ${other} | ${report.targetComposes ? "yes" : `no, after ${report.failure!.afterStage}`} | ${report.conflicts.length} files, ${report.conflictHunks} hunks, ${report.conflictLines} lines | ${report.forkFilesChangedUpstream} | ${report.upstreamFilesChanged} (${report.upstreamRustFilesChanged} .rs) |`;
  });

  const failures = reports.flatMap((report) =>
    report.failure ? [`- ${report.app}: ${report.failure.error}`] : [],
  );

  const conflicts = reports.flatMap((report) =>
    report.conflicts.map(
      (file) =>
        `- ${report.app} \`${file.path}\` (${file.stages.join(", ")}): ${file.merge.status}${"hunks" in file.merge ? `, ${file.merge.hunks} hunks / ${file.merge.lines} lines` : ""}`,
    ),
  );

  return [
    "| Editor | Pinned → target (releases behind) | Files edited + added | Fork lines ± protocol / other | Composer applies | Three-way conflicts | Fork-edited files changed upstream | Upstream files changed |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...(failures.length ? ["First composer failure per editor:", "", ...failures, ""] : []),
    ...(conflicts.length ? ["Conflicting files:", "", ...conflicts, ""] : []),
  ].join("\n");
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const targets = new Map<NativeApp, string>();
  let cache = join(tmpdir(), "hyori-artcraft-drift-cache");
  let json: string | undefined;
  let useCandidate = false;
  let failOnDrift = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;

    if (arg === "--cache") cache = args[++index]!;
    else if (arg === "--json") json = args[++index]!;
    else if (arg === "--candidate") useCandidate = true;
    else if (arg === "--fail-on-drift") failOnDrift = true;
    else if (arg === "--target") {
      const [name, tag] = args[++index]!.split("=");
      const app = nativeApps.find((candidate) => candidate === name);

      if (!app || !tag) throw new Error(`Bad --target ${name}=${tag}`);
      targets.set(app, tag);
    } else throw new Error(`Unknown argument ${arg}`);
  }

  if (useCandidate && targets.size > 0) throw new Error("Use either --candidate or --target");
  await mkdir(cache, { recursive: true });
  const reports = [];
  let pinFailure = false;

  for (const app of nativeApps) {
    try {
      reports.push(await measure(app, cache, targets.get(app), useCandidate));
    } catch (error) {
      pinFailure = true;
      console.error(`${app}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const summary = markdown(reports);
  console.log(summary);

  if (process.env.GITHUB_STEP_SUMMARY)
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## ArtCraft upstream drift\n\n${summary}\n`);

  if (json) await writeFile(json, `${JSON.stringify(reports, null, 2)}\n`);

  if (pinFailure) process.exit(1);

  if (failOnDrift && reports.some((report) => !report.targetComposes || report.conflicts.length))
    process.exit(2);
}
