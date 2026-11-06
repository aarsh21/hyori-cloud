import { cp, mkdir, readFile, readdir, lstat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { cargoMetadataSchema } from "./closure-graph.ts";
import { DECK_MARKS_VERSION, patchDeckMarks } from "./deckcraft-marks.ts";
import { patchDeckCraft } from "./deckcraft-patch.ts";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { readGitSourceArchive, readToolArchive, sha256 } from "./evidence-bytes.ts";

const sourcePin = {
  url: "https://codeload.github.com/storytold/deckcraft/tar.gz/refs/tags/v0.14.1",
  sha256: "6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7",
  commit: "ee39ff67816d0039143ec7c98ea604cefe0cd2e5",
};

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

const toolInputsSchema = z.object({
  archives: z.array(
    z.object({ members: z.array(z.object({ output: z.string(), sha256: z.string() })) }),
  ),
  bun: z.object({ sha256: z.string() }),
});

async function bundle(entry: string, target: "browser" | "bun") {
  const result = await Bun.build({ entrypoints: [entry], target, format: "esm", minify: false });

  if (!result.success || result.outputs.length !== 1)
    throw new Error(`Owned bundle failed: ${result.logs.join("\n")}`);

  return Buffer.from(await result.outputs[0]!.arrayBuffer());
}

interface RetainedBridge {
  path: string;
  sha256: string;
}

/** Only public checksummed cache payloads, never a user's Cargo home/config/credentials. */
async function prepare(
  destination: string,
  publicCache: string,
  tools: string,
  archivePath: string,
  retainedBridge?: RetainedBridge,
  marks = false,
) {
  await mkdir(destination); // Fresh exclusive staging root. A failed preparation is not reusable.
  const input = join(destination, "input");
  const driver = join(destination, "driver");

  for (const path of [input, driver, join(destination, "work"), join(destination, "output")])
    await mkdir(path);

  const toolInputs = toolInputsSchema.parse(
    JSON.parse(await readFile(join(tools, "tool-inputs.json"), "utf8")),
  );

  for (const member of toolInputs.archives.flatMap((archive) => archive.members)) {
    if (sha256(await readFile(join(tools, member.output))) !== member.sha256)
      throw new Error(`Tool payload changed: ${member.output}`);
  }

  if (sha256(await readFile(join(tools, "bin/bun"))) !== pins.bun.sha256)
    throw new Error("Bun input changed");

  const archive = await readFile(archivePath);

  if (sha256(archive) !== sourcePin.sha256)
    throw new Error("DeckCraft tagged source checksum mismatch");
  const original = readGitSourceArchive(archive, "deckcraft-0.14.1", sourcePin.commit);
  const hostRust = await readFile("tooling/artcraft/patches/deckcraft-host-v1/host.rs");

  if (retainedBridge) {
    const info = await lstat(retainedBridge.path);

    if (!info.isFile() || info.size > 8 * 1024 * 1024)
      throw new Error("Retained bridge must be a bounded regular public source file");
  }

  const hostJavaScript = retainedBridge
    ? await readFile(retainedBridge.path)
    : await bundle(
        `tooling/artcraft/patches/deckcraft-host-${marks ? "v2" : "v1"}/host-entry.ts`,
        "browser",
      );

  if (retainedBridge && sha256(hostJavaScript) !== retainedBridge.sha256)
    throw new Error("Retained bridge source checksum mismatch");

  const hosted = patchDeckCraft(original, { hostRust, hostJavaScript });

  // A distributed modified build carries Hyori's marks, not ArtCraft's. See deckcraft-marks.ts.
  const patched = marks
    ? patchDeckMarks(hosted.files, {
        favicon: await readFile("apps/web/public/favicon.ico"),
        icon: await readFile("apps/web/public/icon-192.png"),
      })
    : hosted;

  const files: { path: string; bytes: number; sha256: string }[] = [];

  async function retain(path: string, bytes: Buffer) {
    await mkdir(dirname(join(input, path)), { recursive: true });
    await writeFile(join(input, path), bytes, { flag: "wx" });
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  for (const [path, bytes] of patched.files) await retain(`source/${path}`, bytes);
  const lock = lockSchema.parse(Bun.TOML.parse(original.get("Cargo.lock")!.toString()));

  const metadata = cargoMetadataSchema.parse(
    JSON.parse(await readFile("tooling/artcraft/closure/evidence/deckcraft/metadata.json", "utf8")),
  );

  const registry = "index.crates.io-1949cf8c6b5b557f";
  let crates = 0;

  for (const pkg of lock.package) {
    if (!pkg.source?.startsWith("registry+")) continue;
    const locked = pkg;

    if (!locked.checksum) throw new Error(`No Cargo.lock checksum: ${pkg.name}@${pkg.version}`);
    const filename = `${pkg.name}-${pkg.version}.crate`;
    let bytes: Buffer;

    try {
      bytes = await readFile(join(publicCache, "registry/cache", registry, filename));
    } catch {
      if (marks)
        throw new Error(`Offline .2 preparation requires retained locked crate: ${filename}`);
      bytes = await fetchBuildInput(
        `https://static.crates.io/crates/${pkg.name}/${filename}`,
        locked.checksum,
      );
    }

    if (sha256(bytes) !== locked.checksum) throw new Error(`Crate checksum mismatch: ${filename}`);

    // The locked inactive Windows bindings exceed the legal collector's small-crate cap.
    // Use the separate bounded build-input reader, then require this exact crate root.
    for (const path of readToolArchive(bytes).keys()) {
      if (!path.startsWith(`${pkg.name}-${pkg.version}/`))
        throw new Error(`Unexpected crate archive root: ${filename}`);
    }

    await retain(`cargo/registry/cache/${registry}/${filename}`, bytes);
    crates += 1;
  }

  // Locked workspace resolution may inspect indices of inactive platform packages too.
  for (const name of new Set(
    lock.package.filter((pkg) => pkg.source?.startsWith("registry+")).map((pkg) => pkg.name),
  )) {
    let key = `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;

    if (name.length === 1) key = `1/${name}`;

    if (name.length === 2) key = `2/${name}`;

    if (name.length === 3) key = `3/${name[0]}/${name}`;

    const path = `registry/index/${registry}/.cache/${key}`;

    try {
      await retain(`cargo/${path}`, await readFile(join(publicCache, path)));
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
  }

  await retain(
    `cargo/registry/index/${registry}/config.json`,
    Buffer.from('{"dl":"https://static.crates.io/crates","api":"https://crates.io"}\n'),
  );

  const gitDatabaseNames = new Set(
    metadata.packages.flatMap((pkg) =>
      pkg.source?.startsWith("git+")
        ? [pkg.manifest_path.match(/\/git\/checkouts\/([^/]+)\//)?.[1]].filter(
            (name): name is string => Boolean(name),
          )
        : [],
    ),
  );

  for (const database of gitDatabaseNames) {
    const base = join(publicCache, "git/db", database);

    async function copyObjects(relative: string) {
      const path = join(base, relative);
      const info = await lstat(path);

      if (info.isSymbolicLink()) throw new Error(`Git cache link rejected: ${relative}`);

      if (info.isDirectory()) {
        for (const entry of await readdir(path)) await copyObjects(join(relative, entry));
      } else if (info.isFile())
        await retain(`cargo/git/db/${database}/${relative}`, await readFile(path));
      else throw new Error(`Git cache special file rejected: ${relative}`);
    }

    for (const path of ["objects", "refs", "HEAD", "packed-refs", "shallow"]) {
      try {
        await copyObjects(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }
    }

    await retain(
      `cargo/git/db/${database}/config`,
      Buffer.from("[core]\n bare = true\n repositoryformatversion = 0\n filemode = true\n"),
    );
  }

  const zodRoot = dirname(require.resolve("zod/package.json"));
  await retain("legal/zod/LICENSE", await readFile(join(zodRoot, "LICENSE")));
  await retain("legal/zod/package.json", await readFile(join(zodRoot, "package.json")));
  await writeFile(
    join(driver, "driver.js"),
    await bundle("scripts/artcraft/deckcraft-build-driver.ts", "bun"),
    { flag: "wx" },
  );

  const plan = {
    schemaVersion: 1,
    artifactVersion: marks ? DECK_MARKS_VERSION : pins.artifactVersion,
    deployable: false,
    sourcePin,
    sourceCargoLockSha256: sha256(original.get("Cargo.lock")!),
    // Marks are applied after the bridge; retain the COMPLETE final-vs-tagged source delta.
    patchedFiles: [...patched.files].flatMap(([path, body]) => {
      const before = original.get(path);

      return before?.equals(body)
        ? []
        : [{ path, before: before ? sha256(before) : null, after: sha256(body) }];
    }),
    crates,
    gitDatabaseNames: [...gitDatabaseNames],
    files,
    hostJavaScriptSha256: sha256(hostJavaScript),
    tools: pins,
    legalInputs: {
      closureManifestSha256: sha256(await readFile("tooling/artcraft/closure/manifest.json")),
      zod: "input/legal/zod",
      fullNoticeAuditComplete: false,
      compilerGeneratedNoticesComplete: false,
    },
    gates: {
      sdkIntegrated: false,
      realBrowserWasmRoundTrip: false,
      protectedMarksReplaced: false,
      pptxFidelityVerified: false,
    },
  };

  await writeFile(join(destination, "build-inputs.json"), `${JSON.stringify(plan, null, 2)}\n`, {
    flag: "wx",
  });
  await cp(join(tools, "tool-inputs.json"), join(destination, "tool-inputs.json"));

  return destination;
}

if (import.meta.main) {
  // --marks builds the distributable identity. Without it, this reproduces the historical build.
  const marks = process.argv.includes("--marks");
  const args = process.argv.filter((argument) => argument !== "--marks");
  const [, , destination, cache, tools, source, bridgePath, bridgeHash] = args;

  if (
    !destination ||
    !cache ||
    !tools ||
    !source ||
    ![6, 8].includes(args.length) ||
    (bridgePath && !bridgeHash)
  )
    throw new Error(
      "Usage: bun scripts/artcraft/deckcraft-build.ts NEW_STAGING PUBLIC_CACHE PINNED_TOOLS VERIFIED_SOURCE_TAR_GZ [RETAINED_BRIDGE_SOURCE SHA256]",
    );

  const retainedBridge =
    bridgePath && bridgeHash ? { path: resolve(bridgePath), sha256: bridgeHash } : undefined;

  console.log(
    await prepare(
      resolve(destination),
      resolve(cache),
      resolve(tools),
      resolve(source),
      retainedBridge,
      marks,
    ),
  );
}
