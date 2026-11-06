import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import baseAuthority from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };
import { readAcquisitionFile } from "./content-delivery.ts";
import {
  checkRuntimeBundle,
  runtimeManifestName,
  runtimeManifestSchema,
} from "./content-runtime.ts";
import { digest } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";
import {
  checkGzipTransportSidecar,
  createGzipTransportSidecar,
  transportSidecarSchema,
} from "./transport-sidecars.ts";

const maxFiles = 10000;
const maxBytes = 512 * 1024 * 1024;
const maxManifestBytes = 8 * 1024 * 1024;
const [officialEditor, markedEditor] = runtimeManifestSchema.shape.editors.element.options;

// This is only the frozen all-four bundle plus transport representations, not a general v2 producer.
export const compressionManifestSchema = runtimeManifestSchema
  .extend({
    schemaVersion: z.literal(2),
    editors: z
      .array(
        z.union([
          officialEditor.extend({ role: z.literal("current") }).strict(),
          markedEditor.extend({ role: z.literal("current") }).strict(),
        ]),
      )
      .length(4),
    transportSidecars: z.array(transportSidecarSchema).length(8),
  })
  .strict();

type BaseManifest = z.infer<typeof runtimeManifestSchema>;

type CompressionManifest = z.infer<typeof compressionManifestSchema>;

async function readManifest(root: string, expectedHash: string) {
  digest.parse(expectedHash);

  const stat = await lstat(join(root, runtimeManifestName));

  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxManifestBytes)
    throw new Error("Transport manifest file/size limit");

  const bytes = await readAcquisitionFile(root, runtimeManifestName);

  if (bytes.length > maxManifestBytes || sha256(bytes) !== expectedHash)
    throw new Error("Transport manifest pin mismatch");

  return { bytes, input: z.unknown().parse(JSON.parse(bytes.toString())) };
}

async function verifiedBase(root: string) {
  const verified = await checkRuntimeBundle(root, baseAuthority.manifestSha256);
  const { input } = await readManifest(root, baseAuthority.manifestSha256);
  const manifest = runtimeManifestSchema.parse(input);

  if (
    !isDeepStrictEqual(input, manifest) ||
    !isDeepStrictEqual(verified.editors, baseAuthority.editors) ||
    verified.verifiedFiles !== baseAuthority.assetFiles ||
    manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0) !== baseAuthority.assetBytes
  )
    throw new Error("Transport base differs from frozen all-four authority");

  return manifest;
}

function originals(base: BaseManifest) {
  const files = base.editors
    .flatMap((editor) => {
      const prefix = `${editor.app}/${editor.version}/`;

      const candidates = editor.files.filter((file) => {
        const name = file.path.slice(prefix.length);

        return (
          file.path.startsWith(prefix) &&
          new RegExp(`^${editor.app}-web-[a-f0-9]{16}(?:_bg)?\\.(?:js|wasm)$`, "u").test(name)
        );
      });

      if (
        candidates.length !== 2 ||
        !candidates.some((file) => file.path.endsWith(".js")) ||
        !candidates.some((file) => file.path.endsWith("_bg.wasm"))
      )
        throw new Error(
          "Frozen transport coverage requires one top-level hashed JS/WASM pair per app",
        );

      return candidates;
    })
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));

  if (files.length !== 8) throw new Error("Frozen transport coverage must contain eight originals");

  return files;
}

function derivedManifest(base: BaseManifest, sidecars: CompressionManifest["transportSidecars"]) {
  const expected = originals(base);

  for (const [index, sidecar] of sidecars.entries()) {
    if (
      !isDeepStrictEqual(sidecar.original, expected[index]) ||
      sidecar.path !== `${expected[index]?.path}.gz`
    )
      throw new Error("Transport sidecar coverage/original binding differs from frozen base");
  }

  return compressionManifestSchema.parse({
    ...base,
    schemaVersion: 2,
    editors: base.editors.map((editor) => ({ ...editor, role: "current" })),
    assets: [
      ...base.assets,
      ...sidecars.map(({ path, bytes, sha256, original }) => {
        const source = base.assets.find((asset) => asset.path === original.path);

        if (!source) throw new Error("Transport original is absent from verified global inventory");

        return {
          path,
          bytes,
          sha256,
          contentType: source.contentType,
          cacheControl: source.cacheControl,
        };
      }),
    ],
    transportSidecars: sidecars,
  });
}

async function checkTree(root: string, manifest: CompressionManifest) {
  const records = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  const directories = new Set<string>();
  let visited = 0;
  let fileCount = 0;

  if (
    records.size !== manifest.assets.length ||
    records.size > maxFiles ||
    manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0) > maxBytes
  )
    throw new Error("Transport duplicate inventory or aggregate limits exceeded");

  for (const path of records.keys()) {
    const parts = path.split("/");

    for (let depth = 1; depth < parts.length; depth++)
      directories.add(parts.slice(0, depth).join("/"));
  }

  async function walk(path: string, depth: number) {
    if (depth > 16 || ++visited > maxFiles * 2)
      throw new Error("Transport directory depth/entry limit");

    const stat = await lstat(join(root, path));

    if (stat.isSymbolicLink()) throw new Error(`Transport symlink rejected: ${path}`);

    if (stat.isDirectory()) {
      if ((stat.mode & 0o777) !== 0o555 || (path && !directories.has(path)))
        throw new Error(`Transport unlisted directory or mode: ${path}`);

      for (const name of await readdir(join(root, path)))
        await walk(path ? `${path}/${name}` : name, depth + 1);

      return;
    }

    const record = records.get(path);

    if (
      !stat.isFile() ||
      (stat.mode & 0o777) !== 0o444 ||
      (!record && path !== runtimeManifestName)
    )
      throw new Error(`Transport unlisted file or mode: ${path}`);

    if (record && stat.size !== record.bytes)
      throw new Error(`Transport file size changed: ${path}`);

    fileCount++;
  }

  await walk("", 0);

  if (fileCount !== records.size + 1) throw new Error("Transport file coverage mismatch");
}

/** Independently verify new bytes against the unchanged, separately verified old authority. */
export async function checkRuntimeTransportBundle(
  root: string,
  expectedHash: string,
  baseRoot: string,
) {
  const { bytes, input } = await readManifest(root, expectedHash);
  const manifest = compressionManifestSchema.parse(input);
  const base = await verifiedBase(baseRoot);
  const expected = derivedManifest(base, manifest.transportSidecars);

  if (!isDeepStrictEqual(input, expected))
    throw new Error(
      "Compression-only manifest changed original payload, notices, headers, roles or claims",
    );

  await checkTree(root, manifest);

  for (const asset of manifest.assets) {
    const body = await readAcquisitionFile(root, asset.path);

    if (body.length !== asset.bytes || sha256(body) !== asset.sha256)
      throw new Error(`Transport byte identity changed: ${asset.path}`);
  }

  for (const [index, sidecar] of manifest.transportSidecars.entries()) {
    const original = originals(base)[index];

    if (!original) throw new Error("Unexpected transport sidecar");

    checkGzipTransportSidecar(sidecar, await readAcquisitionFile(root, sidecar.path), original);
  }

  return {
    schemaVersion: 1,
    kind: "all-four-runtime-compression-only-handoff",
    bundleRoot: root,
    manifest: runtimeManifestName,
    manifestBytes: bytes.length,
    manifestSha256: expectedHash,
    baseAuthority: "tooling/artcraft/runtime-all4-v2.json",
    baseManifestSha256: baseAuthority.manifestSha256,
    baseAssetFiles: baseAuthority.assetFiles,
    baseAssetBytes: baseAuthority.assetBytes,
    assetFiles: manifest.assets.length,
    assetBytes: manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0),
    transportSidecarFiles: manifest.transportSidecars.length,
    transportSidecarBytes: manifest.transportSidecars.reduce((sum, asset) => sum + asset.bytes, 0),
    fileMode: "0444",
    directoryMode: "0555",
    mountPath: manifest.mountPath,
    requiresReadOnlyMount: true,
    editors: baseAuthority.editors,
    deploymentScope: manifest.deploymentScope,
    legalOpinion: false,
    fullNoticeAuditComplete: false,
    compilerGeneratedNoticeAuditComplete: false,
    productIntegrationVerified: false,
    allFourLaunchReady: false,
    transportSidecars: manifest.transportSidecars,
  };
}

async function permissions(root: string, readOnly: boolean) {
  if (!readOnly) await chmod(root, 0o755);

  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);

    if (stat.isSymbolicLink()) throw new Error("Owned transport assembly contains a symlink");

    if (stat.isDirectory()) await permissions(path, readOnly);
    else if (stat.isFile()) await chmod(path, readOnly ? 0o444 : 0o644);
    else throw new Error("Owned transport assembly contains a special file");
  }

  if (readOnly) await chmod(root, 0o555);
}

/** Assemble only into a new root. Never link, chmod, rewrite or add a file to the retained base. */
export async function createRuntimeTransportBundle(destination: string, baseRoot: string) {
  const output = resolve(destination);
  const basePath = resolve(baseRoot);
  const child = relative(basePath, output);

  if (!child || (!child.startsWith("../") && child !== ".."))
    throw new Error("Transport output must be separate from the immutable base");

  try {
    await lstat(output);
    throw new Error("Refusing to overwrite transport destination");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const base = await verifiedBase(basePath);
  await mkdir(dirname(output), { recursive: true });

  const staging = await mkdtemp(join(dirname(output), ".artcraft-transport-"));
  let claimed = false;

  try {
    for (const asset of base.assets) {
      const body = await readAcquisitionFile(basePath, asset.path);

      if (body.length !== asset.bytes || sha256(body) !== asset.sha256)
        throw new Error(`Transport source changed during assembly: ${asset.path}`);

      await mkdir(dirname(join(staging, asset.path)), { recursive: true });
      await writeFile(join(staging, asset.path), body, { flag: "wx" });
    }

    const sidecars: CompressionManifest["transportSidecars"] = [];

    for (const original of originals(base)) {
      const sidecar = createGzipTransportSidecar(
        original,
        await readAcquisitionFile(staging, original.path),
      );

      await writeFile(join(staging, sidecar.record.path), sidecar.bytes, { flag: "wx" });
      sidecars.push(sidecar.record);
    }

    const manifest = derivedManifest(base, sidecars);
    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

    if (bytes.length > maxManifestBytes) throw new Error("Transport manifest exceeds byte limit");

    await writeFile(join(staging, runtimeManifestName), bytes, { flag: "wx" });
    await permissions(staging, true);

    const checked = await checkRuntimeTransportBundle(staging, sha256(bytes), basePath);
    // mkdir is an exclusive publication claim; rename replaces only our own empty placeholder.
    await mkdir(output);
    claimed = true;
    await rename(staging, output);

    return { ...checked, bundleRoot: output };
  } catch (cause) {
    if (claimed) await rmdir(output);

    await permissions(staging, false);
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }
}

if (import.meta.main) {
  const [, , operation, root, base, hash] = process.argv;

  if (
    !root ||
    !base ||
    !["assemble", "check"].includes(operation ?? "") ||
    (operation === "assemble" ? process.argv.length !== 5 : process.argv.length !== 6 || !hash)
  )
    throw new Error(
      "Usage: bun scripts/artcraft/content-runtime-transport.ts assemble NEW_ROOT VERIFIED_BB6_BASE | check NEW_ROOT VERIFIED_BB6_BASE MANIFEST_SHA256",
    );

  console.log(
    JSON.stringify(
      operation === "assemble"
        ? await createRuntimeTransportBundle(root, base)
        : await checkRuntimeTransportBundle(root, digest.parse(hash), base),
      null,
      2,
    ),
  );
}
