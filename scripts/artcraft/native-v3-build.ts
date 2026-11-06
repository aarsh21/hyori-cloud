import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { readToolArchive, sha256 } from "./evidence-bytes.ts";
import {
  composeNativeSource,
  nativeApps,
  nativeAuthoredInputs,
  nativeSourceCommits,
  readPinnedSource,
  type NativeApp,
} from "./native-v3-source.ts";

const registry = "index.crates.io-1949cf8c6b5b557f";

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
});

/** Sparse-index cache key, as Cargo lays it out. */
function indexKey(name: string) {
  if (name.length === 1) return `1/${name}`;

  if (name.length === 2) return `2/${name}`;

  if (name.length === 3) return `3/${name[0]}/${name}`;

  return `${name.slice(0, 2)}/${name.slice(2, 4)}/${name}`;
}

/**
 * Prepares one offline, locked native host v3 build. Only checksummed public cache payloads are
 * copied, never a user's Cargo config or credentials; the staging root must not exist.
 */
export async function prepareNativeBuild(
  app: NativeApp,
  destination: string,
  publicCache: string,
  tools: string,
  archivePath: string,
) {
  await mkdir(destination);
  const input = join(destination, "input");

  for (const path of [input, "driver", "work", "output"].map((name) => resolve(destination, name)))
    await mkdir(path);

  const toolInputs = toolInputsSchema.parse(
    JSON.parse(await readFile(join(tools, "tool-inputs.json"), "utf8")),
  );

  for (const member of toolInputs.archives.flatMap((archive) => archive.members))
    if (sha256(await readFile(join(tools, member.output))) !== member.sha256)
      throw new Error(`Tool payload changed: ${member.output}`);

  if (sha256(await readFile(join(tools, "bin/bun"))) !== pins.bun.sha256)
    throw new Error("Bun input changed");

  const archive = await readFile(archivePath);
  const { pin, original } = readPinnedSource(app, archive);
  const authored = await nativeAuthoredInputs();
  const composed = await composeNativeSource(app, original, authored);
  const files: { path: string; bytes: number; sha256: string }[] = [];

  async function retain(path: string, bytes: Buffer) {
    await mkdir(dirname(join(input, path)), { recursive: true });
    await writeFile(join(input, path), bytes, { flag: "wx" });
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  for (const [path, bytes] of composed.files) await retain(`source/${path}`, bytes);

  const lock = lockSchema.parse(Bun.TOML.parse(original.get("Cargo.lock")!.toString()));
  let crates = 0;

  for (const pkg of lock.package) {
    if (!pkg.source?.startsWith("registry+")) continue;

    if (!pkg.checksum) throw new Error(`No Cargo.lock checksum: ${pkg.name}@${pkg.version}`);
    const filename = `${pkg.name}-${pkg.version}.crate`;
    const bytes = await readFile(join(publicCache, "registry/cache", registry, filename));

    if (sha256(bytes) !== pkg.checksum) throw new Error(`Crate checksum mismatch: ${filename}`);

    for (const path of readToolArchive(bytes).keys())
      if (!path.startsWith(`${pkg.name}-${pkg.version}/`))
        throw new Error(`Unexpected crate archive root: ${filename}`);

    await retain(`cargo/registry/cache/${registry}/${filename}`, bytes);
    crates += 1;
  }

  // Locked workspace resolution may inspect indices of inactive-platform packages too.
  for (const name of new Set(
    lock.package.filter((pkg) => pkg.source?.startsWith("registry+")).map((pkg) => pkg.name),
  )) {
    const path = `registry/index/${registry}/.cache/${indexKey(name)}`;

    await retain(`cargo/${path}`, await readFile(join(publicCache, path)));
  }

  await retain(
    `cargo/registry/index/${registry}/config.json`,
    Buffer.from('{"dl":"https://static.crates.io/crates","api":"https://crates.io"}\n'),
  );

  // Bare Git databases for the locked git sources: objects/refs only plus an authored config.
  const repositories = new Set(
    lock.package.flatMap((pkg) =>
      pkg.source?.startsWith("git+")
        ? [new URL(pkg.source.slice(4)).pathname.split("/").at(-1)!.replace(/\.git$/u, "")]
        : [],
    ),
  );

  const databases = await readdir(join(publicCache, "git/db"));
  const gitDatabaseNames: string[] = [];

  for (const repository of repositories) {
    const matches = databases.filter((name) =>
      new RegExp(`^${repository.replaceAll(".", "\\.")}-[0-9a-f]{16}$`, "u").test(name),
    );

    if (matches.length !== 1) throw new Error(`Expected one public Git database: ${repository}`);
    const database = matches[0]!;
    gitDatabaseNames.push(database);
    const base = join(publicCache, "git/db", database);

    async function copyObjects(relative: string) {
      const info = await lstat(join(base, relative));

      if (info.isSymbolicLink()) throw new Error(`Git cache link rejected: ${relative}`);

      if (info.isDirectory())
        for (const entry of await readdir(join(base, relative)))
          await copyObjects(join(relative, entry));
      else if (info.isFile())
        await retain(`cargo/git/db/${database}/${relative}`, await readFile(join(base, relative)));
      else throw new Error(`Git cache special file rejected: ${relative}`);
    }

    for (const path of ["objects", "refs", "HEAD", "packed-refs", "shallow"])
      try {
        await copyObjects(path);
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
      }

    await retain(
      `cargo/git/db/${database}/config`,
      Buffer.from("[core]\n bare = true\n repositoryformatversion = 0\n filemode = true\n"),
    );
  }

  for (const [path, body] of authored.hostLegal) await retain(`legal/host-bridge/${path}`, body);

  const driver = await Bun.build({
    entrypoints: ["scripts/artcraft/native-v3-build-driver.ts"],
    target: "bun",
    format: "esm",
  });

  if (!driver.success || driver.outputs.length !== 1) throw new Error("Driver bundle failed");
  await writeFile(
    join(destination, "driver/driver.js"),
    Buffer.from(await driver.outputs[0]!.arrayBuffer()),
    { flag: "wx" },
  );

  const plan = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-build-inputs",
    app,
    artifactVersion: composed.version,
    upstreamVersion: pin.version,
    sourcePin: { url: pin.sourceUrl, sha256: pin.sourceSha256, commit: nativeSourceCommits[app] },
    sourceCargoLockSha256: sha256(original.get("Cargo.lock")!),
    stages: composed.stages,
    paletteCssSha256: composed.paletteCssSha256,
    hostJavaScriptSha256: composed.hostJavaScriptSha256,
    // Complete final-vs-tagged delta across every stage.
    patchedFiles: composed.changes,
    crates,
    gitDatabaseNames: gitDatabaseNames.sort(),
    files,
    tools: pins,
    deployable: false,
  };

  await writeFile(join(destination, "build-inputs.json"), `${JSON.stringify(plan, null, 2)}\n`, {
    flag: "wx",
  });
  await cp(join(tools, "tool-inputs.json"), join(destination, "tool-inputs.json"));

  return { destination, app, version: composed.version, changes: composed.changes.length, crates };
}

if (import.meta.main) {
  const [, , app, destination, cache, tools, source] = process.argv;

  if (!app || !destination || !cache || !tools || !source || process.argv.length !== 7)
    throw new Error(
      "Usage: bun scripts/artcraft/native-v3-build.ts APP NEW_STAGING PUBLIC_CARGO_HOME PINNED_TOOLS VERIFIED_SOURCE_TAR_GZ",
    );

  console.log(
    JSON.stringify(
      await prepareNativeBuild(
        z.enum(nativeApps).parse(app),
        resolve(destination),
        resolve(cache),
        resolve(tools),
        resolve(source),
      ),
    ),
  );
}
