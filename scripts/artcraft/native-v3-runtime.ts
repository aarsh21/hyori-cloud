import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import baseAuthority from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };
import { readAcquisitionFile } from "./content-delivery.ts";
import { checkRuntimeBundle, headers, runtimeManifestName } from "./content-runtime.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";
import { payloadSha256 } from "./native-v3-build-evidence.ts";
import { nativeArtifactVersions } from "./native-frame-patch.ts";
import { nativeProductNames } from "./native-v3-marks.ts";
import { nativeApps } from "./native-v3-source.ts";
import {
  checkGzipTransportSidecar,
  createGzipTransportSidecar,
  transportSidecarSchema,
} from "./transport-sidecars.ts";

const toolingRoot = fileURLToPath(new URL("../../tooling/artcraft/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Committed authority revisions, oldest first. A revision is never rewritten: bundles it identifies
 * keep verifying, here and in the server, which compiles every revision in. `record` and `assemble`
 * only ever write the last one.
 */
const revisions = [
  {
    authority: "runtime-native-v3.json",
    receiptRoot: "builds/native-host-v3",
    bundle: "runtime-all4-native-v3",
    handoff: "runtime-all4-native-v3.json",
    protocol: 2,
    replaces: {
      authority: "tooling/artcraft/runtime-all4-transport-v2.json",
      manifestSha256: "8427b8b393061473dcb70807f9758ecd0735115366e98871630a231bd172513d",
      stillAcceptedByServer: true,
    },
  },
  {
    authority: "runtime-native-v3-r2.json",
    receiptRoot: "builds/native-host-v3-r2",
    bundle: "runtime-all4-native-v3-r2",
    handoff: "runtime-all4-native-v3-r2.json",
    protocol: 2,
    replaces: {
      authority: "tooling/artcraft/runtime-all4-native-v3.json",
      manifestSha256: "5697833f6137cd3595b8609ee098d94cb21a32ce65e76077ad72a2f59a1d26db",
      stillAcceptedByServer: true,
    },
  },
  // The first runtime whose host bridge runs in a sandboxed, opaque-origin frame.
  {
    authority: "runtime-native-v3-r3.json",
    receiptRoot: "builds/native-host-v3-r3",
    bundle: "runtime-all4-native-v3-r3",
    handoff: "runtime-all4-native-v3-r3.json",
    protocol: 3,
    replaces: {
      authority: "tooling/artcraft/runtime-all4-native-v3-r2.json",
      manifestSha256: "8c8998f74a6d11b4ebc84f70f70adb284b9e1bed6ea3f6c9b26e99030e5ab4a4",
      stillAcceptedByServer: true,
    },
  },
  {
    authority: "runtime-native-v3-r4.json",
    receiptRoot: "builds/native-host-v3-r4",
    bundle: "runtime-all4-native-v3-r4",
    handoff: "runtime-all4-native-v3-r4.json",
    protocol: 3,
    replaces: {
      authority: "tooling/artcraft/runtime-all4-native-v3-r3.json",
      manifestSha256: "4fbf87ab7eb17b0c2009473bef195f45043e39ff8654f606692c4b4f983b615e",
      stillAcceptedByServer: true,
    },
  },
  {
    authority: "runtime-native-v3-r5.json",
    receiptRoot: "builds/native-host-v3-r5",
    bundle: "runtime-all4-native-v3-r5",
    handoff: "runtime-all4-native-v3-r5.json",
    protocol: 3,
    replaces: {
      authority: "tooling/artcraft/runtime-all4-native-v3-r4.json",
      manifestSha256: "322272308851138cd682a031ee15c6b658d2c752a771aff3135cc608208cfed7",
      stillAcceptedByServer: true,
    },
  },
] as const;

type Revision = (typeof revisions)[number];

/** The revision `record` and `assemble` write: the last entry above. */
export const currentNativeRevision = revisions[revisions.length - 1]!;
const current = currentNativeRevision;
const legalRoot = "legal/native-host-v3";
const bridges = { 2: "hyori-correlated-host-v2", 3: "hyori-correlated-host-v3" } as const;
const bridge = z.enum(Object.values(bridges));
const protocol = z.union([z.literal(2), z.literal(3)]);
const maxFiles = 10000;
const maxBytes = 512 * 1024 * 1024;

const record = z.object({
  path: relativePath,
  bytes: z.number().int().nonnegative(),
  sha256: digest,
});

const receiptSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("hyori-native-host-v3-receipt"),
  app: z.enum(nativeApps),
  artifactVersion: z.string(),
  bridge,
  protocol,
  sourceArchiveSha256: digest,
  buildManifestSha256: digest,
  sourceSummarySha256: digest,
  wasmSha256: digest,
  payloadSha256: digest,
  // Recorded from r2 on; r1 receipts predate it.
  cspScriptHashes: z.array(z.string().regex(/^sha256-[A-Za-z0-9+/]{43}=$/u)).optional(),
  files: z.array(record).min(1).max(100),
});

/** The single committed identity authority, compiled into the server as well. */
export const nativeAuthoritySchema = z
  .object({
    schemaVersion: z.literal(1),
    bridge,
    protocol,
    receiptRoot: z.enum(revisions.map((revision) => revision.receiptRoot)),
    apps: z
      .array(
        z
          .object({
            app: z.enum(nativeApps),
            artifactVersion: z.string(),
            sourceArchiveSha256: digest,
            buildManifestSha256: digest,
            payloadSha256: digest,
            receiptSha256: digest,
            sourceSummarySha256: digest,
            wasmSha256: digest,
          })
          .strict(),
      )
      .length(4),
  })
  .strict();

type Authority = z.infer<typeof nativeAuthoritySchema>;

async function exists(path: string) {
  try {
    await lstat(path);

    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

/** Copies each completed evidence receipt into the repository and writes the authority, once. */
export async function recordNativeAuthority(evidenceRoot: string) {
  const authorityPath = join(toolingRoot, current.authority);

  if (await exists(authorityPath)) throw new Error("Refusing to overwrite native v3 authority");
  const apps: Authority["apps"] = [];
  const writes: [string, Record<string, Buffer>][] = [];

  for (const app of nativeApps) {
    const evidence = join(evidenceRoot, app);
    const receiptBytes = await readFile(join(evidence, "receipt.json"));
    const receipt = receiptSchema.parse(JSON.parse(receiptBytes.toString()));
    const buildManifest = await readFile(join(evidence, "build-manifest.json"));
    const sourceSummary = await readFile(join(evidence, "source-summary.json"));

    if (
      receipt.app !== app ||
      receipt.protocol !== current.protocol ||
      receipt.bridge !== bridges[current.protocol] ||
      receipt.artifactVersion !== nativeArtifactVersions[app] ||
      receipt.buildManifestSha256 !== sha256(buildManifest) ||
      receipt.sourceSummarySha256 !== sha256(sourceSummary) ||
      receipt.payloadSha256 !== payloadSha256(receipt.files)
    )
      throw new Error(`Native ${app} receipt differs from its evidence`);

    // A version names one payload: a rebuilt app may keep an earlier revision's version only if
    // it reproduced that payload bit for bit. Otherwise bump nativeArtifactVersions.
    for (const earlier of revisions.slice(0, -1)) {
      const path = join(toolingRoot, earlier.authority);

      if (!(await exists(path))) continue;

      const named = nativeAuthoritySchema
        .parse(JSON.parse(await readFile(path, "utf8")))
        .apps.find(
          (entry) => entry.app === app && entry.artifactVersion === receipt.artifactVersion,
        );

      if (named && named.payloadSha256 !== receipt.payloadSha256)
        throw new Error(
          `${app} ${receipt.artifactVersion} already names another payload in ${earlier.authority}; bump its version`,
        );
    }

    writes.push([
      app,
      {
        "receipt.json": receiptBytes,
        "build-manifest.json": buildManifest,
        "source-summary.json": sourceSummary,
      },
    ]);
    apps.push({
      app,
      artifactVersion: receipt.artifactVersion,
      sourceArchiveSha256: receipt.sourceArchiveSha256,
      buildManifestSha256: receipt.buildManifestSha256,
      payloadSha256: receipt.payloadSha256,
      receiptSha256: sha256(receiptBytes),
      sourceSummarySha256: receipt.sourceSummarySha256,
      wasmSha256: receipt.wasmSha256,
    });
  }

  const authority = nativeAuthoritySchema.parse({
    schemaVersion: 1,
    bridge: bridges[current.protocol],
    protocol: current.protocol,
    receiptRoot: current.receiptRoot,
    apps,
  });

  // Written only once all four receipts are accepted.
  for (const [app, files] of writes) {
    const target = join(toolingRoot, current.receiptRoot, app);
    await mkdir(target, { recursive: true });

    for (const [name, bytes] of Object.entries(files))
      await writeFile(join(target, name), bytes, { flag: "wx" });
  }

  await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`, { flag: "wx" });

  return authority;
}

/** Reads a committed authority revision and every committed receipt it pins. */
async function committedAuthority(revision: Revision) {
  const bytes = await readFile(join(toolingRoot, revision.authority));
  const authority = nativeAuthoritySchema.parse(JSON.parse(bytes.toString()));

  if (
    authority.receiptRoot !== revision.receiptRoot ||
    authority.protocol !== revision.protocol ||
    authority.bridge !== bridges[revision.protocol]
  )
    throw new Error(`${revision.authority} names another revision's receipts or protocol`);

  const receipts = new Map<
    string,
    { receipt: z.infer<typeof receiptSchema>; files: Map<string, Buffer> }
  >();

  for (const entry of authority.apps) {
    const root = join(toolingRoot, revision.receiptRoot, entry.app);
    const files = new Map<string, Buffer>();

    for (const name of ["receipt.json", "build-manifest.json", "source-summary.json"])
      files.set(name, await readFile(join(root, name)));
    const receipt = receiptSchema.parse(JSON.parse(files.get("receipt.json")!.toString()));

    // Only the current revision names the versions this checkout composes.
    if (
      (revision === current && entry.artifactVersion !== nativeArtifactVersions[entry.app]) ||
      sha256(files.get("receipt.json")!) !== entry.receiptSha256 ||
      sha256(files.get("build-manifest.json")!) !== entry.buildManifestSha256 ||
      sha256(files.get("source-summary.json")!) !== entry.sourceSummarySha256 ||
      receipt.app !== entry.app ||
      receipt.payloadSha256 !== entry.payloadSha256 ||
      receipt.wasmSha256 !== entry.wasmSha256 ||
      payloadSha256(receipt.files) !== entry.payloadSha256
    )
      throw new Error(`Committed native ${entry.app} receipt differs from the authority`);
    receipts.set(entry.app, { receipt, files });
  }

  return { authority, bytes, receipts };
}

function modifications(app: (typeof nativeApps)[number], upstream: string) {
  return Buffer.from(
    `# ${nativeProductNames[app]}: modified ${upstream} ${nativeArtifactVersions[app]}

Based on ${upstream} by the ArtCraft team. This is a modified version, not an official ArtCraft product, and no upstream sponsorship or endorsement is implied.

Changes from the tagged upstream source: direct native host methods, correlated protocol ${current.protocol} bridge (background save, parsed-open and durable acknowledgement, host-driven theme, running in a sandboxed opaque-origin frame from protocol 3), interface colours from Hyori's palette, and removal of the ArtCraft marks, community promotion and upstream brand links as the upstream brand licence requires of modified versions. Plain-text copyright and source attribution remain.

- original-legal/: upstream LICENSE-MIT, LICENSE-APACHE, NOTICE, ATTRIBUTION.md and docs/brand/LICENSE-brand.txt, byte-identical to the tagged source.
- modified-source/: every changed or added source member, complete.
- source-summary.json: the tagged source pin and every before/after hash.
- build-manifest.json and receipt.json: tools, commands, artifact hashes.
- host-bridge-legal/: licences of the JavaScript packages compiled into the host bridge.
- tool-legal/: Rust standard library and build tool licences.
${hostedChanges[app]}
Dependency notices are unchanged from the upstream graph and are in ../../NOTICE-INDEX.md.
`,
  );
}

/** What a revision changed beyond the shared native host work, per app. */
const hostedChanges: Record<(typeof nativeApps)[number], string> = {
  wordcraft:
    "\nInside the Hyori host, the upstream Share button and account avatar are not drawn: Hyori owns sharing and the account. Standalone use keeps both.\n",
  gridcraft: "",
  pdfcraft: "",
  deckcraft:
    "\nThe Light/Dark toggle keeps one icon in both themes. Inter Regular and Bold (SIL OFL 1.1, unmodified) are embedded through upstream's own craft-fonts build input, so presentations draw in their theme font; font-legal/inter/ has the licence and pinned source.\n",
};

const upstreamNames = {
  wordcraft: "WordCraft",
  gridcraft: "GridCraft",
  pdfcraft: "PdfCraft",
  deckcraft: "DeckCraft",
} as const;

const noticeIndex = Buffer.from(`# Hyori editor static assets and notices

This bundle contains Hyori Documents, Hyori Spreadsheets, Hyori PDF and Hyori Presentations: modified builds of WordCraft 0.14.0, GridCraft 0.15.0, PdfCraft 0.17.0 and DeckCraft 0.14.1 by the ArtCraft team. They are not official ArtCraft products.

- [Shared dependency notices](NOTICE-INDEX.md) and [adopted AFM/AGL/PDFium evidence](adopted-data/ADOPTION.md).
- Each modified build: native-host-v3/<app>/MODIFICATIONS.md, with complete changed source and original upstream legal files.
- The earlier modified DeckCraft .2 record (deckcraft-host-v2/) stays because later Deck builds compose over its host engine changes.
- Hyori Presentations embeds the Inter typeface (SIL OFL 1.1): native-host-v3/deckcraft/font-legal/inter/.

Deployable means verified static-asset composition only, not legal advice or product-launch acceptance.
`);

async function setModes(root: string, readOnly: boolean) {
  if (!readOnly) await chmod(root, 0o755);

  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);

    if (stat.isSymbolicLink()) throw new Error("Native runtime assembly contains a link");

    if (stat.isDirectory()) await setModes(path, readOnly);
    else if (stat.isFile()) await chmod(path, readOnly ? 0o444 : 0o644);
    else throw new Error("Native runtime assembly contains a special file");
  }

  if (readOnly) await chmod(root, 0o555);
}

/** Trunk prints its u64 content hash unpadded, so a name can carry fewer than 16 digits. */
const TRUNK_HASH = "[a-f0-9]{1,16}";

/** content-runtime's headers, except that a top-level Trunk-hashed output is immutable however short its hash. */
function nativeHeaders(path: string) {
  const derived = headers(path);

  return new RegExp(
    `^(?!legal/)[^/]+/[^/]+/[^/]+-${TRUNK_HASH}(?:_bg)?\\.(?:wasm|js|ico|css)$`,
    "u",
  ).test(path)
    ? { ...derived, cacheControl: "public, max-age=31536000, immutable" }
    : derived;
}

/**
 * The committed handoff for a revision's bundle. Everything in it derives from the manifest and the
 * authority, so `assemble` writes it and `check` regenerates it byte for byte.
 */
function handoffReceipt(
  revision: Revision,
  authority: Authority,
  manifestBytes: Buffer,
  manifest: { assets: { bytes: number }[]; transportSidecars: { bytes: number }[] },
  receipts: Map<string, { receipt: z.infer<typeof receiptSchema> }>,
) {
  const bundleRoot = `tooling/artcraft/.generated/${revision.bundle}`;
  const total = (files: { bytes: number }[]) => files.reduce((sum, file) => sum + file.bytes, 0);

  const receipt = {
    schemaVersion: 1,
    kind: "all-four-native-host-v3-runtime-handoff",
    bundleRoot,
    manifest: runtimeManifestName,
    runtimeManifestSchemaVersion: 2,
    manifestBytes: manifestBytes.length,
    manifestSha256: sha256(manifestBytes),
    assetFiles: manifest.assets.length,
    assetBytes: total(manifest.assets),
    transportSidecarFiles: manifest.transportSidecars.length,
    transportSidecarBytes: total(manifest.transportSidecars),
    encoder: "gzip-level6-mtime0-os255-v1",
    fileMode: "0444",
    directoryMode: "0555",
    mountPath: "/artcraft",
    requiresReadOnlyMount: true,
    authority: `tooling/artcraft/${revision.authority}`,
    legalBase: {
      authority: "tooling/artcraft/runtime-all4-v2.json",
      manifestSha256: baseAuthority.manifestSha256,
      reused: "every legal/ file except RUNTIME-NOTICE-INDEX.md",
    },
    replaces: revision.replaces,
    editors: authority.apps.map((entry) => ({
      app: entry.app,
      version: entry.artifactVersion,
      role: "current",
      bridge: authority.bridge,
      protocol: authority.protocol,
      assetUrl: `/artcraft/${entry.app}/${entry.artifactVersion}/index.html?host=parent`,
      payloadSha256: entry.payloadSha256,
      wasmSha256: entry.wasmSha256,
      // CSP hashes of the inline loader in index.html; absent for r1, so its handoff is unchanged.
      cspScriptHashes: receipts.get(entry.app)!.receipt.cspScriptHashes,
    })),
    deploymentScope: "verified-static-assets-only-not-product-launch-or-legal-clearance",
    legalOpinion: false,
    fullNoticeAuditComplete: false,
    compilerGeneratedNoticeAuditComplete: false,
    productIntegrationVerified: false,
    allFourLaunchReady: false,
    check: `bun scripts/artcraft/native-v3-runtime.ts check ${bundleRoot} <manifestSha256>`,
  };

  return Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
}

/**
 * Assembles the current revision's manifest-v2 bundle with the four native editors and gzip
 * sidecars, then writes its committed handoff receipt.
 */
export async function createNativeRuntime(
  destination: string,
  baseRoot: string,
  evidenceRoot: string,
) {
  const output = resolve(destination);
  const bundle = join(toolingRoot, ".generated", current.bundle);
  const handoffPath = join(toolingRoot, current.handoff);

  // The handoff names one bundle path, so the bundle can only be assembled there.
  if (output !== bundle)
    throw new Error(`The current native bundle belongs at ${relative(repositoryRoot, bundle)}`);

  if ((await exists(output)) || (await exists(handoffPath)))
    throw new Error("Refusing to overwrite the native runtime bundle or its handoff");
  await checkRuntimeBundle(resolve(baseRoot), baseAuthority.manifestSha256);

  const base = z
    .object({ assets: z.array(record) })
    .parse(JSON.parse((await readAcquisitionFile(baseRoot, runtimeManifestName)).toString()));

  const { authority, bytes: authorityBytes, receipts } = await committedAuthority(current);
  const files = new Map<string, Buffer>();

  for (const asset of base.assets) {
    if (!asset.path.startsWith("legal/") || asset.path === "legal/RUNTIME-NOTICE-INDEX.md")
      continue;
    files.set(asset.path, await readAcquisitionFile(baseRoot, asset.path));
  }

  files.set("legal/RUNTIME-NOTICE-INDEX.md", noticeIndex);
  files.set(`${legalRoot}/authority.json`, authorityBytes);
  const editors = [];
  const originals = [];

  for (const entry of authority.apps) {
    const { receipt, files: committed } = receipts.get(entry.app)!;
    const evidence = join(evidenceRoot, entry.app);

    const buildManifest = z
      .object({ assets: z.array(record) })
      .parse(JSON.parse((await readFile(join(evidence, "build-manifest.json"))).toString()));

    if (
      !(await readFile(join(evidence, "build-manifest.json"))).equals(
        committed.get("build-manifest.json")!,
      )
    )
      throw new Error(`Evidence for ${entry.app} differs from its committed receipt`);

    for (const asset of buildManifest.assets) {
      const legal =
        /^(modified-source|original-legal|host-bridge-legal|tool-legal|font-legal)\//u.test(
          asset.path,
        );

      if (!legal && !asset.path.startsWith("artifact/")) continue;
      const bytes = await readAcquisitionFile(evidence, asset.path);

      if (bytes.length !== asset.bytes || sha256(bytes) !== asset.sha256)
        throw new Error(`Native ${entry.app} evidence bytes changed: ${asset.path}`);
      files.set(
        legal
          ? `${legalRoot}/${entry.app}/${asset.path}`
          : `${entry.app}/${entry.artifactVersion}/${asset.path.slice("artifact/".length)}`,
        bytes,
      );
    }

    for (const [name, bytes] of committed) files.set(`${legalRoot}/${entry.app}/${name}`, bytes);
    files.set(
      `${legalRoot}/${entry.app}/MODIFICATIONS.md`,
      modifications(entry.app, upstreamNames[entry.app]),
    );

    for (const file of receipt.files) {
      const bytes = files.get(file.path);

      if (!bytes || bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
        throw new Error(`Native ${entry.app} payload differs from its receipt: ${file.path}`);
    }

    const index = `${entry.app}/${entry.artifactVersion}/index.html`;
    editors.push({
      app: entry.app,
      role: "current",
      protocol: authority.protocol,
      version: entry.artifactVersion,
      sourceArchiveSha256: entry.sourceArchiveSha256,
      buildManifestSha256: entry.buildManifestSha256,
      payloadSha256: entry.payloadSha256,
      index,
      assetUrl: `/artcraft/${index}?host=parent`,
      bridge: authority.bridge,
      deployable: true,
      files: receipt.files,
    });
    // One top-level hashed JS and WASM per app get precompressed transport representations.

    const top = receipt.files.filter((file) =>
      new RegExp(
        `^${entry.app}/${entry.artifactVersion.replaceAll(".", "\\.")}/${entry.app}-web-${TRUNK_HASH}(?:_bg\\.wasm|\\.js)$`,
        "u",
      ).test(file.path),
    );

    if (top.length !== 2) throw new Error(`Expected one top-level JS/WASM pair for ${entry.app}`);
    originals.push(...top);
  }

  const sidecars = originals
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((original) => {
      const sidecar = createGzipTransportSidecar(original, files.get(original.path)!);
      files.set(sidecar.record.path, sidecar.bytes);

      return sidecar.record;
    });

  const assets = [...files]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, bytes]) => {
      const sidecar = sidecars.find((entry) => entry.path === path);

      return {
        path,
        bytes: bytes.length,
        sha256: sha256(bytes),
        ...nativeHeaders(sidecar ? sidecar.original.path : path),
      };
    });

  if (assets.length > maxFiles || assets.reduce((sum, asset) => sum + asset.bytes, 0) > maxBytes)
    throw new Error("Native runtime bundle limits exceeded");

  const manifest = {
    schemaVersion: 2,
    kind: "artcraft-runtime-static-bundle",
    purpose: "runtime",
    mountPath: "/artcraft",
    deployable: true,
    deploymentScope: "verified-static-assets-only-not-product-launch-or-legal-clearance",
    legalOpinion: false,
    fullNoticeAuditComplete: false,
    compilerGeneratedNoticeAuditComplete: false,
    productIntegrationVerified: false,
    allFourLaunchReady: false,
    editors,
    notices: { index: "legal/RUNTIME-NOTICE-INDEX.md", authority: `${legalRoot}/authority.json` },
    serving: {
      sameOrigin: true,
      nosniff: true,
      readOnly: true,
      executeUploadedDocumentsHere: false,
      unknownPaths: "404-no-SPA-fallback",
      rangeAndHead: true,
    },
    assets,
    transportSidecars: sidecars,
  };

  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), ".native-runtime-"));

  try {
    for (const [path, bytes] of files) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await writeFile(join(staging, path), bytes, { flag: "wx" });
    }

    await writeFile(join(staging, runtimeManifestName), manifestBytes, { flag: "wx" });
    await setModes(staging, true);
    await checkNativeRuntime(staging, sha256(manifestBytes));
    await rename(staging, output);
    await writeFile(
      handoffPath,
      handoffReceipt(current, authority, manifestBytes, manifest, receipts),
      {
        flag: "wx",
      },
    );
  } catch (cause) {
    await setModes(staging, false);
    await rm(staging, { recursive: true, force: true });
    throw cause;
  }

  return {
    bundleRoot: output,
    handoff: relative(repositoryRoot, handoffPath),
    manifestBytes: manifestBytes.length,
    manifestSha256: sha256(manifestBytes),
    assetFiles: assets.length,
    assetBytes: assets.reduce((sum, asset) => sum + asset.bytes, 0),
    editors: editors.map(({ app, version, assetUrl, payloadSha256 }) => ({
      app,
      version,
      assetUrl,
      payloadSha256,
    })),
  };
}

/** Independent check: pinned manifest, exact inventory and modes, every hash, sidecars, authority. */
export async function checkNativeRuntime(root: string, expectedSha256: string) {
  const bytes = await readAcquisitionFile(root, runtimeManifestName);

  if (sha256(bytes) !== digest.parse(expectedSha256))
    throw new Error("Native runtime manifest pin mismatch");

  const manifest = z
    .object({
      schemaVersion: z.literal(2),
      editors: z
        .array(
          z.object({
            app: z.enum(nativeApps),
            version: z.string(),
            payloadSha256: digest,
            bridge,
            protocol,
            files: z.array(record),
          }),
        )
        .length(4),
      assets: z.array(record.extend({ contentType: z.string(), cacheControl: z.string() })),
      transportSidecars: z.array(transportSidecarSchema).length(8),
    })
    .parse(JSON.parse(bytes.toString()));

  // The bundle carries exactly one committed authority revision; that one identifies it.
  const carried = await readAcquisitionFile(root, `${legalRoot}/authority.json`);
  let revision: Revision | undefined;

  for (const candidate of revisions) {
    const path = join(toolingRoot, candidate.authority);

    if ((await exists(path)) && (await readFile(path)).equals(carried)) revision = candidate;
  }

  if (!revision) throw new Error("Native runtime carries no committed authority revision");
  const { authority, bytes: authorityBytes, receipts } = await committedAuthority(revision);
  const inventory = new Map(manifest.assets.map((asset) => [asset.path, asset]));

  if (inventory.size !== manifest.assets.length) throw new Error("Duplicate native runtime asset");

  for (const entry of authority.apps) {
    const editor = manifest.editors.find((candidate) => candidate.app === entry.app);

    if (
      !editor ||
      editor.bridge !== authority.bridge ||
      editor.protocol !== authority.protocol ||
      editor.version !== entry.artifactVersion ||
      editor.payloadSha256 !== entry.payloadSha256 ||
      payloadSha256(editor.files) !== entry.payloadSha256 ||
      JSON.stringify(editor.files) !== JSON.stringify(receipts.get(entry.app)!.receipt.files)
    )
      throw new Error(`Native runtime editor differs from the authority: ${entry.app}`);

    for (const [name, committed] of receipts.get(entry.app)!.files)
      if (inventory.get(`${legalRoot}/${entry.app}/${name}`)?.sha256 !== sha256(committed))
        throw new Error(`Native runtime receipt missing: ${entry.app}/${name}`);
  }

  if (inventory.get(`${legalRoot}/authority.json`)?.sha256 !== sha256(authorityBytes))
    throw new Error("Native runtime authority missing");

  let seen = 0;

  async function walk(relative: string): Promise<void> {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, path));

      if (stat.isSymbolicLink()) throw new Error(`Native runtime link: ${path}`);

      if ((stat.mode & 0o777) !== (stat.isDirectory() ? 0o555 : 0o444))
        throw new Error(`Native runtime mode must be 0444/0555: ${path}`);

      if (stat.isDirectory()) await walk(path);
      else if (path !== runtimeManifestName) {
        const asset = inventory.get(path);
        const body = await readAcquisitionFile(root, path);

        if (!asset || body.length !== asset.bytes || sha256(body) !== asset.sha256)
          throw new Error(`Native runtime bytes unlisted or changed: ${path}`);
        seen += 1;
      }
    }
  }

  await walk("");

  if (seen !== inventory.size) throw new Error("Native runtime inventory coverage mismatch");

  for (const sidecar of manifest.transportSidecars)
    checkGzipTransportSidecar(
      sidecar,
      await readAcquisitionFile(root, sidecar.path),
      sidecar.original,
    );

  // A committed handoff for this exact manifest must be what the manifest and authority derive.
  const handoffPath = join(toolingRoot, revision.handoff);
  let handoff = "not committed for this manifest";

  if (await exists(handoffPath)) {
    const committed = await readFile(handoffPath);

    if (JSON.parse(committed.toString()).manifestSha256 === expectedSha256) {
      if (!committed.equals(handoffReceipt(revision, authority, bytes, manifest, receipts)))
        throw new Error(`${revision.handoff} differs from the bundle it hands off`);
      handoff = `verified ${revision.handoff}`;
    }
  }

  return {
    manifestSha256: expectedSha256,
    authority: revision.authority,
    handoff,
    verifiedFiles: seen,
    editors: manifest.editors.map(({ app, version }) => ({ app, version })),
  };
}

if (import.meta.main) {
  const [, , operation, ...args] = process.argv;
  let result: unknown;

  if (operation === "record" && args.length === 1)
    result = await recordNativeAuthority(resolve(args[0]!));
  else if (operation === "assemble" && args.length === 3)
    result = await createNativeRuntime(args[0]!, args[1]!, resolve(args[2]!));
  else if (operation === "check" && args.length === 2)
    result = await checkNativeRuntime(resolve(args[0]!), args[1]!);
  else
    throw new Error(
      `Usage: bun scripts/artcraft/native-v3-runtime.ts record EVIDENCE_ROOT | assemble tooling/artcraft/.generated/${current.bundle} VERIFIED_ALL4_V2_BASE EVIDENCE_ROOT | check ROOT MANIFEST_SHA256`,
    );

  console.log(JSON.stringify(result, null, 2));
}
