import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import candidates from "../../tooling/artcraft/upstream-candidate.json" with { type: "json" };
import { readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import type { NativeApp, NativeAuthoredInputs } from "./native-v3-source.ts";

const patchRoot = new URL("../../tooling/artcraft/patches/native-host-v3-r6/", import.meta.url);

export const candidateArtifactVersions = {
  wordcraft: "0.18.1-hyori-host.1",
  gridcraft: "0.19.1-hyori-host.1",
  pdfcraft: "0.22.0-hyori-host.2",
  deckcraft: "0.18.1-hyori-host.1",
} as const;

export function readCandidateSource(app: NativeApp, archive: Buffer) {
  const pin = candidates.editors.find((editor) => editor.app === app);

  if (!pin || sha256(archive) !== pin.sourceSha256)
    throw new Error(`${app} candidate source checksum mismatch`);

  return { pin, original: readGitSourceArchive(archive, `${app}-${pin.version}`, pin.commit) };
}

/** Applies the reviewed textual port to the exact tag without executing anything from the archive. */
export async function composeCandidateSource(
  app: NativeApp,
  original: ReadonlyMap<string, Buffer>,
  authored: NativeAuthoredInputs,
  staging: string,
) {
  const patch = await readFile(new URL(`${app}.patch`, patchRoot));
  const scratch = await mkdtemp(join(staging, ".source-patch-"));
  const files = new Map(original);

  const apply = (args: string[]) => {
    const child = Bun.spawnSync(["git", "apply", ...args, "-"], {
      cwd: scratch,
      stdin: patch,
      env: {
        PATH: process.env.PATH,
        GIT_CEILING_DIRECTORIES: dirname(scratch),
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
    });

    if (child.exitCode !== 0) throw new Error(`${app}: ${child.stderr.toString().trim()}`);

    return child.stdout.toString();
  };

  try {
    const paths = apply(["--numstat", "-z"])
      .split("\0")
      .filter(Boolean)
      .map((entry) => {
        const path = /^\d+\t\d+\t((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]+)$/u.exec(entry)?.[1];

        // The hosted PDF build changes only these dependency inputs: native-only OCR and the
        // patched URL parser. Other ports must preserve the upstream dependency declarations.
        if (
          app === "pdfcraft" &&
          (path === "Cargo.lock" ||
            path === "crates/engine/Cargo.toml" ||
            path === "crates/ui-egui/Cargo.toml")
        )
          return path;

        if (
          !path ||
          !/^(?:apps|crates)\//u.test(path) ||
          path.split("/").some((part) => part.startsWith(".")) ||
          /(?:^|\/)(?:Cargo\.toml|Cargo\.lock|LICENSE[^/]*|NOTICE|ATTRIBUTION\.md)$/u.test(path)
        )
          throw new Error(`${app} candidate patch has an unsupported path: ${entry}`);

        return path;
      });

    if (paths.length === 0 || new Set(paths).size !== paths.length)
      throw new Error(`${app} candidate patch has no paths or duplicate paths`);

    for (const path of paths) {
      const body = original.get(path);

      if (!body) continue;
      await mkdir(dirname(join(scratch, path)), { recursive: true });
      await writeFile(join(scratch, path), body);
    }

    apply(["--whitespace=nowarn"]);

    for (const path of paths) files.set(path, await readFile(join(scratch, path)));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const web = `apps/${app}-web`;
  const version = candidateArtifactVersions[app];

  const host = files
    .get(`${web}/src/${app === "deckcraft" ? "host" : "native_host"}.rs`)
    ?.toString();

  if (!host?.includes(`pub const NATIVE_ARTIFACT_VERSION: &str = "${version}";`))
    throw new Error(`${app} host handshake does not match its artifact version ${version}`);

  const generated = new Map([
    [`${web}/hyori-mark.ico`, authored.favicon],
    [`${web}/hyori-native-host.js`, authored.hostJavaScript],
    [`${web}/src/native_host/clock.rs`, authored.clock],
    ["assets/hyori-mark.png", authored.icon],
  ]);

  if (app === "pdfcraft")
    generated.set("crates/ui-egui/hyori-pdf-print.js", authored.pdfPrintJavaScript);

  for (const [path, bytes] of generated) {
    if (files.has(path)) throw new Error(`${app} candidate composition would replace ${path}`);
    files.set(path, bytes);
  }

  const changes = [...files].flatMap(([path, body]) => {
    const before = original.get(path);

    return before?.equals(body)
      ? []
      : [{ path, before: before ? sha256(before) : null, after: sha256(body) }];
  });

  return {
    version,
    files,
    changes: changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    stages: ["candidate-source-patch", "shared-native-assets"],
    paletteCssSha256: sha256(authored.css),
    hostJavaScriptSha256: sha256(authored.hostJavaScript),
  };
}
