import { mkdtemp, mkdir, open, readFile, rename, rm, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { assertAuditedAsset } from "./content-delivery.ts";
import { packageNoticeFiles } from "./content-package-notices.ts";

import manifest from "../../tooling/artcraft/manifest.json" with { type: "json" };
import redistribution from "../../tooling/artcraft/redistribution.json" with { type: "json" };
import { sha256 } from "./evidence-bytes.ts";
import { expandZipEntry, validateZipArchive } from "./validated-zip.ts";

type Release = (typeof manifest.editors)[number];

async function downloadRelease(release: Release, directory: string): Promise<Buffer> {
  const response = await fetch(release.url, {
    credentials: "omit",
    signal: AbortSignal.timeout(90_000),
  });

  if (!response.ok || !response.body)
    throw new Error(`Could not download ${release.app}: HTTP ${response.status}`);

  const file = await open(join(directory, "release.zip"), "wx");
  const reader = response.body.getReader();
  let received = 0;

  try {
    for (;;) {
      const chunk = await reader.read();

      if (chunk.done) break;

      received += chunk.value.byteLength;

      if (received > release.bytes) throw new Error(`Download exceeds pinned size: ${release.app}`);

      await file.writeFile(chunk.value);
    }
  } finally {
    await reader.cancel();
    await file.close();
  }

  const bytes = await readFile(join(directory, "release.zip"));

  if (received !== release.bytes || sha256(bytes) !== release.sha256)
    throw new Error(`Archive checksum mismatch: ${release.app}`);

  return bytes;
}

export async function acquireArtCraft(destination: string): Promise<string> {
  return acquireWithReader(destination, downloadRelease);
}

/** Explicit offline path: no fetch fallback; the same official pins and ZIP rules apply. */
export async function acquireArtCraftFromArchives(
  destination: string,
  configPath: string,
): Promise<string> {
  const config = z
    .object({
      editors: z
        .array(
          z.object({
            app: z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]),
            releaseArchive: z.string(),
          }),
        )
        .length(4),
    })
    .parse(JSON.parse(await readFile(configPath, "utf8")));

  if (new Set(config.editors.map((editor) => editor.app)).size !== 4)
    throw new Error("Duplicate/missing official archive input");

  return acquireWithReader(destination, async (release) => {
    const path = config.editors.find((editor) => editor.app === release.app)!.releaseArchive;
    const stat = await lstat(path);

    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== release.bytes)
      throw new Error(`Archive size/type mismatch: ${release.app}`);

    return readFile(path);
  });
}

async function acquireWithReader(
  destination: string,
  reader: (release: Release, directory: string) => Promise<Buffer>,
): Promise<string> {
  const output = resolve(destination);

  try {
    await lstat(output);
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") {
      return installArtCraft(output, reader);
    }

    throw cause;
  }

  throw new Error(`Refusing to overwrite existing ArtCraft output: ${output}`);
}

async function installArtCraft(
  output: string,
  reader: (release: Release, directory: string) => Promise<Buffer>,
): Promise<string> {
  // Missing/corrupt local evidence must fail before downloading or creating an installation.
  const notices = await packageNoticeFiles();
  const { delivery, closure } = notices;
  await mkdir(dirname(output), { recursive: true });

  // Extraction is separate from every fresh download directory. No upstream code is executed.
  const installation = await mkdtemp(join(dirname(output), ".artcraft-"));
  const assets: { path: string; bytes: number; sha256: string; contentType: string }[] = [];

  async function installAsset(path: string, bytes: Buffer, mime = contentType(path)) {
    const target = join(installation, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });
    assets.push({ path, bytes: bytes.length, sha256: sha256(bytes), contentType: mime });
  }

  try {
    for (const release of manifest.editors) {
      const staging = await mkdtemp(join(tmpdir(), `hyori-${release.app}-archive-`));

      try {
        const archive = await reader(release, staging);

        if (archive.length !== release.bytes || sha256(archive) !== release.sha256)
          throw new Error(`Archive checksum mismatch: ${release.app}`);
        const entries = validateZipArchive(archive, release.archiveRoot, manifest.limits);
        const prefix = `${release.app}/${release.version}`;

        if (
          !entries.some((entry) => entry.path === "index.html") ||
          !entries.some((entry) => entry.path.endsWith(".wasm"))
        ) {
          throw new Error(`Missing browser payload: ${release.app}`);
        }

        for (const entry of entries) {
          if (entry.directory) continue;

          const bytes = expandZipEntry(entry);
          const path = `${prefix}/${entry.path}`;
          assertAuditedAsset(
            delivery.discovered,
            `${release.app}@${release.version}`,
            entry.path,
            bytes,
          );
          await installAsset(path, bytes);
        }
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }

    // One byte-preserving composition also feeds independent runtime-bundle verification.
    for (const [path, body] of notices.files) await installAsset(path, body);

    assets.sort((a, b) => a.path.localeCompare(b.path, "en"));

    const artifactManifest = {
      schemaVersion: 1,
      deployable: false,
      editors: manifest.editors.map((release) => ({
        app: release.app,
        version: release.version,
        archiveSha256: release.sha256,
        index: `${release.app}/${release.version}/index.html`,
        bridge: release.bridge,
        hostQuery: release.bridge === "upstream-host-parent" ? "host=parent" : null,
        deployable: false,
      })),
      // Acquisition is not runtime/fidelity or legal-audit evidence. Keep this explicit in the
      // generated deployment input so a future installer cannot mistake extraction for approval.
      redistribution: {
        status: redistribution.status,
        manifest: "legal/redistribution.json",
        supplement: "legal/REDISTRIBUTION-SUPPLEMENT.md",
        matchingSymphoniaSources: "legal/SYMPHONIA-SOURCES.md",
        declaredClosureManifest: "legal/closure.json",
        matchedDependencyNotices: "legal/DEPENDENCY-NOTICES.md",
        localNoticeIndex: "legal/NOTICE-INDEX.md",
        contentNoticeManifest: "legal/content/notice-manifest.json",
        contentCoverage: "legal/content-coverage.json",
        contentSupplementIndexSha256: delivery.indexSha256,
        localNoticeDeliveryVerified: true,
        runtimePublication: false,
        compilerGeneratedNoticeAuditComplete: false,
        protectedMarksCleared: false,
        legalOpinion: false,
        declaredTargetGraphsResolved: closure.proof.declaredTargetGraphsResolved,
        exactProductionDependencyClosureVerified: false,
        fullNoticeAuditComplete: false,
      },
      outstanding: closure.remaining,
      hosting: {
        exactSameOrigin: true,
        vendorCodeIsTrusted: true,
        uploadedHtmlAndSvgMustNotExecuteHere: true,
        indexCacheControl: "no-cache",
        hashedAssetCacheControl: "public, max-age=31536000, immutable",
        nosniff: true,
      },
      assets,
    };

    await writeFile(
      join(installation, "artifact-manifest.json"),
      `${JSON.stringify(artifactManifest, null, 2)}\n`,
      { flag: "wx" },
    );
    await rename(installation, output);

    return join(output, "artifact-manifest.json");
  } catch (cause) {
    await rm(installation, { recursive: true, force: true });

    throw cause;
  }
}

function contentType(path: string): string {
  if (path.endsWith(".wasm")) return "application/wasm";

  if (path.endsWith(".js")) return "text/javascript; charset=utf-8";

  if (path.endsWith(".html")) return "text/html; charset=utf-8";

  if (path.endsWith(".ico")) return "image/x-icon";

  return "text/plain; charset=utf-8";
}
