import { cp, lstat, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import deckFonts from "../../tooling/artcraft/patches/native-host-v3/deck-fonts.json" with { type: "json" };
import { readToolArchive, sha256 } from "./evidence-bytes.ts";
import { composeCandidateSource, readCandidateSource } from "./native-v3-candidate.ts";
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
  fontsDirectory?: string,
  candidate = false,
) {
  // Deck embeds Inter through upstream's own craft-fonts build input; no other app takes fonts.
  if ((app === "deckcraft") !== (fontsDirectory !== undefined))
    throw new Error("Deck needs the verified craft-fonts directory, and only Deck takes one");

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
  const { pin, original } = (candidate ? readCandidateSource : readPinnedSource)(app, archive);
  const authored = await nativeAuthoredInputs();

  const composed = candidate
    ? await composeCandidateSource(app, original, authored, destination)
    : await composeNativeSource(app, original, authored);

  const files: { path: string; bytes: number; sha256: string }[] = [];

  async function retain(path: string, bytes: Buffer) {
    await mkdir(dirname(join(input, path)), { recursive: true });
    await writeFile(join(input, path), bytes, { flag: "wx" });
    files.push({ path, bytes: bytes.length, sha256: sha256(bytes) });
  }

  for (const [path, bytes] of composed.files) await retain(`source/${path}`, bytes);

  const buildLock = composed.files.get("Cargo.lock")!;
  const lock = lockSchema.parse(Bun.TOML.parse(buildLock.toString()));
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
        ? [
            new URL(pkg.source.slice(4)).pathname
              .split("/")
              .at(-1)!
              .replace(/\.git$/u, ""),
          ]
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

  let embeddedFonts: typeof deckFonts | null = null;

  if (fontsDirectory !== undefined) {
    const verified = async (path: string, expected: string) => {
      const bytes = await readFile(join(fontsDirectory, path));

      if (sha256(bytes) !== expected) throw new Error(`Font input differs from its pin: ${path}`);

      return bytes;
    };

    const license = await verified(deckFonts.licenseFile, deckFonts.licenseSha256);

    // Only the pinned faces, through craft-fonts' own manifest format; the main manifest is empty.
    const rows = deckFonts.faces.map(
      (face) =>
        `${face.family} | ${face.style} | ${face.path} | Latn | ${deckFonts.license} | ${deckFonts.licenseFile} | ${face.sha256} | ${deckFonts.upstream}`,
    );

    for (const face of deckFonts.faces) {
      const bytes = await verified(face.path, face.sha256);

      if (bytes.length !== face.bytes) throw new Error(`Font input size differs: ${face.path}`);
      await retain(`craft-fonts/${face.path}`, bytes);
    }

    await retain(`craft-fonts/${deckFonts.licenseFile}`, license);
    await retain(
      "craft-fonts/fonts/latin-manifest.txt",
      Buffer.from(`# Hyori: the pinned Inter faces only (deck-fonts.json)\n${rows.join("\n")}\n`),
    );
    await retain(
      "craft-fonts/fonts/manifest.txt",
      Buffer.from("# Hyori: no Japanese, symbol or RTL faces are embedded in this web build\n"),
    );
    await retain("legal/fonts/inter/OFL.txt", license);
    await retain(
      "legal/fonts/inter/SOURCE.md",
      Buffer.from(`# Inter (embedded in Hyori Presentations)

${deckFonts.faces.map((face) => `- ${face.family} ${face.style}: \`${face.path}\`, ${face.bytes} bytes, SHA-256 \`${face.sha256}\``).join("\n")}

Source: ${deckFonts.source.repository} at ${deckFonts.source.commit} (${deckFonts.source.pinnedBy}), byte-identical to ${deckFonts.upstream}.

${deckFonts.copyright}. Licensed under the SIL Open Font License, Version 1.1 (${deckFonts.license}); see OFL.txt. The font files are unmodified.
`),
    );
    embeddedFonts = deckFonts;
  }

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

  const sourceCargoLockSha256 = sha256(original.get("Cargo.lock")!);
  const buildCargoLockSha256 = sha256(buildLock);

  const plan = {
    schemaVersion: 1,
    kind: "hyori-native-host-v3-build-inputs",
    app,
    artifactVersion: composed.version,
    upstreamVersion: pin.version,
    sourcePin: {
      url: pin.sourceUrl,
      sha256: pin.sourceSha256,
      commit: "commit" in pin ? pin.commit : nativeSourceCommits[app],
    },
    sourceCargoLockSha256,
    buildCargoLockSha256:
      buildCargoLockSha256 === sourceCargoLockSha256 ? undefined : buildCargoLockSha256,
    stages: composed.stages,
    paletteCssSha256: composed.paletteCssSha256,
    hostJavaScriptSha256: composed.hostJavaScriptSha256,
    embeddedFonts,
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
  const args = process.argv.slice(2);
  const candidate = args[0] === "--candidate";
  const [app, destination, cache, tools, source, fonts] = candidate ? args.slice(1) : args;

  if (!app || !destination || !cache || !tools || !source || args.length > (candidate ? 7 : 6))
    throw new Error(
      "Usage: bun scripts/artcraft/native-v3-build.ts [--candidate] APP NEW_STAGING PUBLIC_CARGO_HOME PINNED_TOOLS VERIFIED_SOURCE_TAR_GZ [CRAFT_FONTS_DIR, Deck only]",
    );

  console.log(
    JSON.stringify(
      await prepareNativeBuild(
        z.enum(nativeApps).parse(app),
        resolve(destination),
        resolve(cache),
        resolve(tools),
        resolve(source),
        fonts === undefined ? undefined : resolve(fonts),
        candidate,
      ),
    ),
  );
}
