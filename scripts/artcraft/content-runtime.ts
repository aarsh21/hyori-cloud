import { chmod, lstat, mkdir, mkdtemp, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };
import { packageNoticeFiles } from "./content-package-notices.ts";
import { readAcquisitionFile } from "./content-delivery.ts";
import { adoptionIndexSha256 } from "./content-adoption.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";
import { markedDeckRuntime, markedDeckRuntimeBytes } from "./content-runtime-deck.ts";
import { markedDeckVersion } from "./deckcraft-artifact-identity.ts";

const mountPath = "/artcraft";
export const runtimeManifestName = "runtime-bundle-manifest.json";
const app = z.enum(["wordcraft", "gridcraft", "pdfcraft"]);

const assetSchema = z.object({
  path: relativePath,
  bytes: z
    .number()
    .int()
    .nonnegative()
    .max(128 * 1024 * 1024),
  sha256: digest,
  contentType: z.string(),
  cacheControl: z.enum(["no-cache", "public, max-age=31536000, immutable"]),
});

const editorSchema = z.object({
  app,
  version: z.string(),
  archiveSha256: digest,
  index: relativePath,
  assetUrl: z.string(),
  bridge: z.literal("upstream-host-parent"),
  deployable: z.literal(true),
  files: z
    .array(z.object({ path: relativePath, bytes: z.number().int().nonnegative(), sha256: digest }))
    .max(100),
});

const markedEditorSchema = z.object({
  app: z.literal("deckcraft"),
  version: z.literal(markedDeckVersion),
  sourceArchiveSha256: digest,
  buildManifestSha256: digest,
  payloadSha256: digest,
  index: relativePath,
  assetUrl: z.string(),
  bridge: z.literal("hyori-correlated-host-v1"),
  deployable: z.literal(true),
  files: z
    .array(z.object({ path: relativePath, bytes: z.number().int().nonnegative(), sha256: digest }))
    .length(6),
});

const readinessSchema = z.object({
  app: z.enum(["wordcraft", "gridcraft", "pdfcraft", "deckcraft"]),
  version: z.string(),
  staticDistribution: z.enum(["supported-notices-composed", "excluded-modified-marks-and-build"]),
  substantiveDistributionBlockers: z.array(z.string()),
  productAcceptance: z.array(z.string()),
  residualConfidence: z.array(z.string()),
});

export const runtimeManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("artcraft-runtime-static-bundle"),
  purpose: z.literal("runtime"),
  mountPath: z.literal(mountPath),
  deployable: z.literal(true),
  deploymentScope: z.literal("verified-static-assets-only-not-product-launch-or-legal-clearance"),
  legalOpinion: z.literal(false),
  fullNoticeAuditComplete: z.literal(false),
  compilerGeneratedNoticeAuditComplete: z.literal(false),
  productIntegrationVerified: z.literal(false),
  allFourLaunchReady: z.literal(false),
  editors: z
    .array(z.discriminatedUnion("bridge", [editorSchema, markedEditorSchema]))
    .min(3)
    .max(4),
  readiness: z.array(readinessSchema).length(4),
  notices: z.object({
    index: z.literal("legal/RUNTIME-NOTICE-INDEX.md"),
    adoptedDataIndex: z.literal("legal/adopted-data/index.json"),
    adoptionIndexSha256: z.literal(adoptionIndexSha256),
  }),
  serving: z.object({
    sameOrigin: z.literal(true),
    nosniff: z.literal(true),
    readOnly: z.literal(true),
    executeUploadedDocumentsHere: z.literal(false),
    unknownPaths: z.literal("404-no-SPA-fallback"),
    rangeAndHead: z.literal(true),
  }),
  assets: z.array(assetSchema).max(10000),
});

function readiness(includeMarked = false) {
  const residual = [
    "Historical toolchain/unique optimized-byte attribution and broad source-only candidates are residual audit confidence, not express permission conditions or blanket deployment blockers.",
    "Original publisher binaries are pinned; a hash is identity, not a signed independent build/link attestation.",
  ];

  const productAcceptance = [
    "Real authorized backend + SDK + browser open/edit/save/reopen and relevant error/recovery paths must pass before product launch.",
    "Browser/mobile and native/import/export format fidelity are separate product acceptance, not static redistribution permission evidence.",
  ];

  return [
    ...official.editors
      .filter((editor) => editor.app !== "deckcraft")
      .map((editor) => ({
        app: editor.app,
        version: editor.version,
        staticDistribution: "supported-notices-composed",
        substantiveDistributionBlockers: [],
        productAcceptance,
        residualConfidence:
          editor.app === "pdfcraft"
            ? [
                ...residual,
                "AFM/AGL/PDFium adoption supplies supported existing-data correspondence/notice basis; original authors' exact historical inputs are not asserted. Current mapping semantics are preserved.",
              ]
            : residual,
      })),
    {
      app: "deckcraft",
      version: includeMarked ? markedDeckVersion : "0.14.1-hyori-host.1",
      staticDistribution: includeMarked
        ? "supported-notices-composed"
        : "excluded-modified-marks-and-build",
      substantiveDistributionBlockers: includeMarked
        ? []
        : [
            "Official 0.14.1 has no verified cloud host-storage bridge; not a substitute for the correlated modified build.",
            "Modified .1 retains protected marks; upstream modified-version terms require removal/replacement. Opus exclusively owns that patch and distinct new version.",
            "After Opus patch/version handoff, one coordinated restricted offline build, changed-input notices and native bridge verification are required before adding the new exact payload/hash entry.",
          ],
      productAcceptance,
      residualConfidence: residual,
    },
  ];
}

export function headers(path: string) {
  const legal = path.startsWith("legal/");

  const contentType = legal
    ? path.endsWith(".json")
      ? "application/json"
      : "text/plain; charset=utf-8"
    : path.endsWith(".wasm")
      ? "application/wasm"
      : path.endsWith(".js")
        ? "text/javascript; charset=utf-8"
        : path.endsWith(".html")
          ? "text/html; charset=utf-8"
          : path.endsWith(".ico")
            ? "image/x-icon"
            : path.endsWith(".css")
              ? "text/css; charset=utf-8"
              : "text/plain; charset=utf-8";

  const immutable = !legal && /-[a-f0-9]{16}(?:_bg)?\.(?:wasm|js|ico|css)$/.test(path);

  return {
    contentType,
    cacheControl: immutable ? "public, max-age=31536000, immutable" : "no-cache",
  } satisfies Pick<z.infer<typeof assetSchema>, "contentType" | "cacheControl">;
}

/** No acquisition manifest is trusted to delete required notices or add unaudited executable bytes. */
async function expectedRuntimeFiles(includeMarked = false) {
  const notices = await packageNoticeFiles();
  const extraNotices = new Map<string, Buffer>();
  extraNotices.set(
    "legal/RUNTIME-NOTICE-INDEX.md",
    Buffer.from(
      `# ArtCraft static distribution notices\n\n[Complete local notice index](NOTICE-INDEX.md) · [Adopted existing-data record](adopted-data/ADOPTION.md) · [AFM-specific terms and companion file](adopted-data/adobe-core14/readme.txt) · [AGL grant](adopted-data/adobe-agl/glyphlist.txt) · [PDFium licence](adopted-data/pdfium/LICENSE)\n\nThis bundle contains unchanged official WordCraft 0.14.0, GridCraft 0.15.0 and PdfCraft 0.17.0 plus all preserved upstream notices and conservative supplemental notices. The Adobe AFM/AGL/PDFium evidence is positively adopted; no mapping/font behavior is changed. Keep every notice and source-availability reference accessible alongside the assets. Original ArtCraft marks remain only within unchanged official editors under their retained brand terms; do not use them as Hyori branding or imply endorsement.\n\nThe runtime manifest's deployable flag means verified STATIC-ASSET COMPOSITION only. Historical audit/acquisition records deliberately retain false full-audit/legal-opinion/product flags; they do not silently overrule this later per-app supported-notice assessment. General legal clearance is not asserted. Modified Deck .1 is excluded pending Opus mark patch, coordinated distinct-version build and product acceptance. All four apps remain launch requirements. Static composition does not prove actual backend/SDK/browser lifecycle or format fidelity. Residual source/link confidence alone is not a newly invented permission condition.\n`,
    ),
  );

  const payload = notices.delivery.discovered.assets.filter(
    (asset) => !asset.artifact.startsWith("deckcraft@"),
  );

  const records = new Map<string, { bytes: number; sha256: string }>();

  for (const asset of payload) {
    const [name, version] = asset.artifact.split("@");
    records.set(`${name}/${version}/${asset.path}`, { bytes: asset.bytes, sha256: asset.sha256 });
  }

  for (const [path, body] of [...notices.files, ...extraNotices])
    records.set(path, { bytes: body.length, sha256: sha256(body) });

  const marked = includeMarked ? await markedDeckRuntime() : null;

  if (marked) {
    for (const [path, record] of marked.records) {
      if (records.has(path))
        throw new Error(`Marked Deck collides with shared runtime assets: ${path}`);
      records.set(path, { bytes: record.bytes, sha256: record.sha256 });
    }

    const index = Buffer.from(
      `# All-four ArtCraft-based static assets and notices\n\nThis bundle contains unchanged official WordCraft 0.14.0, GridCraft 0.15.0 and PdfCraft 0.17.0 plus Hyori Presentations, the separately versioned modified DeckCraft ${markedDeckVersion}. Based on DeckCraft by the ArtCraft team; no upstream sponsorship or endorsement is implied.\n\n[Complete shared notices](NOTICE-INDEX.md), [adopted AFM/AGL/PDFium evidence](adopted-data/ADOPTION.md), and [modified Deck source/attribution](deckcraft-host-v2/MODIFICATIONS.md) accompany all executable assets. Preserve every original permission, copyright, NOTICE, matching-source link, complete changed-source member and companion AFM file. No uploaded document may execute in this trusted-code origin.\n\nThe modified .2 identity is pinned by authority.json/receipt.json/build-manifest.json under deckcraft-host-v2/. Opus's exact marks/source patch and the restricted offline build are verified; .1 remains historical and is NOT shipped. Current .2 behavior makes imported PPTX ordinary Save an explicit native copy; read-only replacement is rejected while authorized explicit copy is permitted. These are not claims of .2 browser/backend acceptance.\n\nDeployable means supported verified STATIC-ASSET COMPOSITION only, not legal advice, full audit clearance or product-launch acceptance. All-four launch readiness stays false pending actual public SDK/backend/WASM open/edit/save/reopen and relevant conflict/copy/export/revocation/fidelity checks. Historical audit/earlier acquisition records remain confidence snapshots, not blanket unique-optimized-byte proof gates.\n`,
    );

    extraNotices.set("legal/RUNTIME-NOTICE-INDEX.md", index);
    records.set("legal/RUNTIME-NOTICE-INDEX.md", { bytes: index.length, sha256: sha256(index) });
  }

  return { records, notices: notices.files, extraNotices, marked };
}

export async function createRuntimeBundle(
  destination: string,
  acquiredRoot: string,
  markedEvidenceRoot?: string,
) {
  const output = resolve(destination);

  try {
    await lstat(output);
    throw new Error("Refusing to overwrite runtime bundle destination");
  } catch (cause) {
    if (!(cause instanceof Error && "code" in cause && cause.code === "ENOENT")) throw cause;
  }

  const expected = await expectedRuntimeFiles(Boolean(markedEvidenceRoot));
  const markedBytes = markedEvidenceRoot ? await markedDeckRuntimeBytes(markedEvidenceRoot) : null;
  await mkdir(dirname(output), { recursive: true });
  const temporary = await mkdtemp(join(dirname(output), ".artcraft-runtime-"));
  const assets: z.infer<typeof assetSchema>[] = [];

  try {
    for (const [path, record] of [...expected.records].sort(([a], [b]) =>
      a.localeCompare(b, "en"),
    )) {
      const body =
        expected.extraNotices.get(path) ??
        markedBytes?.files.get(path) ??
        (await readAcquisitionFile(acquiredRoot, path));

      if (body.length !== record.bytes || sha256(body) !== record.sha256)
        throw new Error(`Runtime input missing/changed or notice adoption absent: ${path}`);
      await mkdir(dirname(join(temporary, path)), { recursive: true });
      await writeFile(join(temporary, path), body, { flag: "wx" });
      assets.push({ path, ...record, ...headers(path) });
    }

    const manifest = runtimeManifestSchema.parse({
      schemaVersion: 1,
      kind: "artcraft-runtime-static-bundle",
      purpose: "runtime",
      mountPath,
      deployable: true,
      deploymentScope: "verified-static-assets-only-not-product-launch-or-legal-clearance",
      legalOpinion: false,
      fullNoticeAuditComplete: false,
      compilerGeneratedNoticeAuditComplete: false,
      productIntegrationVerified: false,
      allFourLaunchReady: false,
      editors: [
        ...official.editors
          .filter((editor) => editor.app !== "deckcraft")
          .map((editor) => ({
            app: editor.app,
            version: editor.version,
            archiveSha256: editor.sha256,
            index: `${editor.app}/${editor.version}/index.html`,
            assetUrl: `${mountPath}/${editor.app}/${editor.version}/index.html?host=parent`,
            bridge: "upstream-host-parent",
            deployable: true,
            files: assets.flatMap(({ path, bytes, sha256 }) =>
              path.startsWith(`${editor.app}/${editor.version}/`) ? [{ path, bytes, sha256 }] : [],
            ),
          })),
        ...(expected.marked ? [expected.marked.editor] : []),
      ],
      readiness: readiness(Boolean(expected.marked)),
      notices: {
        index: "legal/RUNTIME-NOTICE-INDEX.md",
        adoptedDataIndex: "legal/adopted-data/index.json",
        adoptionIndexSha256,
      },
      serving: {
        sameOrigin: true,
        nosniff: true,
        readOnly: true,
        executeUploadedDocumentsHere: false,
        unknownPaths: "404-no-SPA-fallback",
        rangeAndHead: true,
      },
      assets,
    });

    const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);

    if (
      bytes.length > 8 * 1024 * 1024 ||
      assets.reduce((sum, asset) => sum + asset.bytes, 0) > 512 * 1024 * 1024
    )
      throw new Error("Runtime bundle limits exceeded");
    await writeFile(join(temporary, runtimeManifestName), bytes, { flag: "wx" });
    await runtimePermissions(temporary, true);
    await rename(temporary, output);

    return {
      manifest: join(output, runtimeManifestName),
      manifestSha256: sha256(bytes),
      assetFiles: assets.length,
      editors: manifest.editors,
      allFourLaunchReady: false,
    };
  } catch (cause) {
    await runtimePermissions(temporary, false);
    await rm(temporary, { recursive: true, force: true });
    throw cause;
  }
}

async function runtimePermissions(root: string, readOnly: boolean) {
  // Used only for the newly owned assembly directory, never an existing runtime/live mount.
  if (!readOnly) await chmod(root, 0o755);

  for (const name of await readdir(root)) {
    const path = join(root, name);
    const stat = await lstat(path);

    if (stat.isSymbolicLink()) throw new Error("Runtime assembly link rejected");

    if (stat.isDirectory()) await runtimePermissions(path, readOnly);
    else if (stat.isFile()) await chmod(path, readOnly ? 0o444 : 0o644);
    else throw new Error("Runtime assembly special file rejected");
  }

  if (readOnly) await chmod(root, 0o555);
}

export async function checkRuntimeBundle(root: string, expectedManifestSha256: string) {
  digest.parse(expectedManifestSha256);
  const rootStat = await lstat(root);

  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || (rootStat.mode & 0o777) !== 0o555)
    throw new Error("Runtime root must be 0555 and not a link");
  const manifestStat = await lstat(join(root, runtimeManifestName));

  if (
    !manifestStat.isFile() ||
    manifestStat.isSymbolicLink() ||
    manifestStat.size > 8 * 1024 * 1024
  )
    throw new Error("Runtime manifest file/size limit");
  const bytes = await readAcquisitionFile(root, runtimeManifestName);

  if (bytes.length > 8 * 1024 * 1024 || sha256(bytes) !== expectedManifestSha256)
    throw new Error("Runtime manifest pin mismatch");
  const manifest = runtimeManifestSchema.parse(JSON.parse(bytes.toString()));

  const includeMarked = manifest.editors.some(
    (editor) => editor.bridge === "hyori-correlated-host-v1",
  );

  const expected = await expectedRuntimeFiles(includeMarked);

  if (
    manifest.editors.length !== (includeMarked ? 4 : 3) ||
    new Set(manifest.editors.map((editor) => editor.app)).size !== manifest.editors.length
  )
    throw new Error("Runtime editor inventory mismatch");
  const recorded = new Map(manifest.assets.map((asset) => [asset.path, asset]));

  if (recorded.size !== manifest.assets.length || recorded.size !== expected.records.size)
    throw new Error("Runtime required file coverage mismatch");

  if (manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0) > 512 * 1024 * 1024)
    throw new Error("Runtime total byte limit");

  for (const [path, record] of expected.records) {
    const asset = recorded.get(path);

    if (
      !asset ||
      asset.bytes !== record.bytes ||
      asset.sha256 !== record.sha256 ||
      JSON.stringify(headers(path)) !==
        JSON.stringify({ contentType: asset.contentType, cacheControl: asset.cacheControl })
    )
      throw new Error(`Required runtime byte/header receipt changed: ${path}`);
    const stat = await lstat(join(root, path));

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== record.bytes)
      throw new Error(`Runtime bytes changed: ${path}`);
    const body = await readAcquisitionFile(root, path);

    if (body.length !== record.bytes || sha256(body) !== record.sha256)
      throw new Error(`Runtime bytes changed: ${path}`);
  }

  for (const pin of official.editors.filter((editor) => editor.app !== "deckcraft")) {
    const editor = manifest.editors.find((editor) => editor.app === pin.app);
    const index = `${pin.app}/${pin.version}/index.html`;

    const expectedFiles = manifest.assets.flatMap(({ path, bytes, sha256 }) =>
      path.startsWith(`${pin.app}/${pin.version}/`) ? [{ path, bytes, sha256 }] : [],
    );

    if (
      !editor ||
      editor.bridge !== "upstream-host-parent" ||
      editor.version !== pin.version ||
      editor.archiveSha256 !== pin.sha256 ||
      editor.index !== index ||
      editor.assetUrl !== `${mountPath}/${index}?host=parent` ||
      JSON.stringify(editor.files) !== JSON.stringify(expectedFiles)
    )
      throw new Error("Runtime editor contract differs from verified official asset");
  }

  if (
    expected.marked &&
    JSON.stringify(manifest.editors.find((editor) => editor.app === "deckcraft")) !==
      JSON.stringify(expected.marked.editor)
  )
    throw new Error("Runtime marked Deck differs from the independently adopted .2 identity");

  if (JSON.stringify(manifest.readiness) !== JSON.stringify(readiness(includeMarked)))
    throw new Error("Per-app readiness claim changed");
  const seen = new Set<string>();

  async function walk(relative = "") {
    for (const name of await readdir(join(root, relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, path));

      if (stat.isSymbolicLink()) throw new Error("Runtime link rejected");

      if ((stat.mode & 0o777) !== (stat.isDirectory() ? 0o555 : 0o444))
        throw new Error(`Runtime mode must be 0444/0555: ${path}`);

      if (stat.isDirectory()) {
        if (![...recorded.keys()].some((file) => file.startsWith(`${path}/`)))
          throw new Error(`Unaccounted runtime directory: ${path}`);
        await walk(path);
      } else if (!stat.isFile() || (path !== runtimeManifestName && !recorded.has(path)))
        throw new Error(`Unaccounted runtime asset: ${path}`);
      else seen.add(path);
    }
  }

  await walk();

  if (seen.size !== recorded.size + 1) throw new Error("Runtime file coverage mismatch");

  return {
    manifestSha256: expectedManifestSha256,
    verifiedFiles: recorded.size,
    editors: manifest.editors.map((editor) => ({
      app: editor.app,
      version: editor.version,
      assetUrl: editor.assetUrl,
    })),
    deployable: true,
    deploymentScope: manifest.deploymentScope,
    allFourLaunchReady: false,
  };
}

if (import.meta.main) {
  const [, , operation, root, input, markedEvidence] = process.argv;

  if (
    !root ||
    !input ||
    ![5, 6].includes(process.argv.length) ||
    (operation === "check" && markedEvidence) ||
    !["assemble", "check"].includes(operation!)
  )
    throw new Error(
      "Usage: bun scripts/artcraft/content-runtime.ts assemble NEW_OUTPUT ACQUIRED_ROOT | check BUNDLE_ROOT EXPECTED_MANIFEST_SHA256",
    );
  console.log(
    JSON.stringify(
      operation === "assemble"
        ? await createRuntimeBundle(root, input, markedEvidence)
        : await checkRuntimeBundle(root, input),
      null,
      2,
    ),
  );
}
