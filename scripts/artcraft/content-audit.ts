import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  auditSchema,
  discoverySchema,
  digest,
  relativePath,
  rustSourceSchema,
} from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

export const contentRoot = fileURLToPath(
  new URL("../../tooling/artcraft/content-audit/", import.meta.url),
);

const legacyRoot = fileURLToPath(new URL("../../tooling/artcraft/", import.meta.url));

export const contentIndexSchema = z.object({
  schemaVersion: z.literal(1),
  deployable: z.literal(false),
  manifest: z.object({ path: relativePath, sha256: digest }),
  discovery: z.object({ path: relativePath, sha256: digest }),
});

/** Checks complete discovered-item disposition and exact evidence, never legal clearance. */
export async function checkContentAudit(root = contentRoot) {
  const index = contentIndexSchema.parse(
    JSON.parse(await readFile(join(root, "index.json"), "utf8")),
  );

  const bytes = await readFile(join(root, index.manifest.path));

  if (sha256(bytes) !== index.manifest.sha256)
    throw new Error("Content audit manifest pin mismatch");
  const audit = auditSchema.parse(JSON.parse(bytes.toString()));
  const discoveredBytes = await readFile(join(root, index.discovery.path));

  if (
    sha256(discoveredBytes) !== index.discovery.sha256 ||
    index.discovery.sha256 !== audit.scope.discoverySha256
  )
    throw new Error("Content discovery pin mismatch");
  const discovered = discoverySchema.parse(JSON.parse(discoveredBytes.toString()));
  const files = new Map<string, Buffer>();

  if (new Set(audit.evidence.map((file) => file.id)).size !== audit.evidence.length)
    throw new Error("Duplicate content evidence id");

  for (const file of audit.evidence) {
    const body = await readFile(join(file.scope === "legacy" ? legacyRoot : root, file.path));

    if (body.length !== file.bytes || sha256(body) !== file.sha256)
      throw new Error(`Content evidence checksum mismatch: ${file.id}`);
    files.set(file.id, body);
  }

  const catalog = audit.evidence.find((file) => file.member === "rust-source-component-manifest");

  if (!catalog) throw new Error("Compiler source component evidence missing");
  const rust = rustSourceSchema.parse(JSON.parse(files.get(catalog.id)!.toString()));

  if (
    rust.sha256 !== audit.scope.rustSourceArchive.sha256 ||
    rust.url !== audit.scope.rustSourceArchive.url
  )
    throw new Error("Compiler source pin mismatch");

  const expected = new Set([
    ...discovered.assets.map((file) => `asset:${file.artifact}:${file.path}`),
    ...discovered.binaries.flatMap((binary) =>
      binary.fonts.map((font) => `font:${binary.artifact}:${font.offset}`),
    ),
    ...discovered.references.map((reference) => `source:${reference.id}`),
    ...discovered.sites
      .filter((site) => site.resolved === null)
      .map(
        (site) =>
          `include:${site.source}:${site.member}:${site.line}:${sha256(Buffer.from(site.expression))}`,
      ),
    ...rust.files.map((file) => `rust-source:${file.member}`),
    ...discovered.binaries.map((binary) => `wasm-unmapped:${binary.artifact}`),
    ...["wasm-bindgen-0.2.129", "trunk-0.21.14", "binaryen-123", "walrus-0.27.2"].map(
      (tool) => `generator:${tool}`,
    ),
    "runtime:rust-1.99.1",
  ]);

  const claimed = new Set(audit.scope.discoveredItemIds);
  const materials = new Map(audit.materials.map((material) => [material.id, material]));

  if (
    claimed.size !== audit.scope.discoveredItemIds.length ||
    materials.size !== audit.materials.length ||
    expected.size !== claimed.size ||
    expected.size !== materials.size ||
    [...expected].some((id) => !claimed.has(id) || !materials.has(id))
  )
    throw new Error("Discovered material missing a coverage disposition");

  for (const material of audit.materials) {
    if (material.evidence.some((id) => !files.has(id)))
      throw new Error(`Unknown material evidence: ${material.id}`);

    if (material.disposition === "notice-evidence-reviewed" && !material.evidence.length)
      throw new Error(`Reviewed material lacks content evidence: ${material.id}`);

    if (material.disposition === "unresolved" && !material.remaining.length)
      throw new Error(`Unresolved material lacks an explicit action: ${material.id}`);

    if (
      material.category === "embedded-font" &&
      !material.evidence.some((id) =>
        audit.evidence.some((file) => file.id === id && file.role === "permission-text"),
      )
    )
      throw new Error(`Font lacks a complete permission-text reference: ${material.id}`);

    if (
      /source:pdfcraft-source:crates\/fonts\/src\/(?:std14_metrics|encodings)\.rs$/.test(
        material.id,
      ) &&
      material.disposition !== "unresolved"
    )
      throw new Error("Adobe-derived data rights cannot be cleared by project SPDX or hashes");
  }

  for (const asset of discovered.assets)
    if (asset.path.startsWith("snippets/eframe-") && asset.path.endsWith("/inline0.js")) {
      const material = materials.get(`asset:${asset.artifact}:${asset.path}`)!;

      const witness = audit.evidence.find(
        (file) =>
          material.evidence.includes(file.id) &&
          file.role === "generator-source" &&
          file.member === "crates/eframe/src/web/text_agent.rs",
      );

      const literal = witness
        ? files
            .get(witness.id)!
            .toString()
            .match(/inline_js\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1]
        : undefined;

      if (!literal || sha256(Buffer.from(z.string().parse(JSON.parse(literal)))) !== asset.sha256)
        throw new Error("Shared eframe snippet source proof is missing or changed");
    }

  const runtime = materials.get("runtime:rust-1.99.1");

  if (
    !runtime?.evidence.some(
      (id) =>
        audit.evidence.some((file) => file.id === id && file.role === "permission-text") &&
        files
          .get(id)
          ?.toString()
          .replace(/\s+/g, " ")
          .includes("MIT AND Apache-2.0 WITH LLVM-exception"),
    )
  )
    throw new Error("Compiler-builtins conjunction/exception content is missing");

  for (const policy of audit.reviewedPolicies)
    if (policy.evidence.some((id) => !files.has(id))) throw new Error("Unknown policy evidence");

  for (const issue of audit.unresolved)
    if (issue.materials.some((id) => !materials.has(id)))
      throw new Error("Unknown unresolved material reference");

  if (
    discovered.binaries.length !== 5 ||
    new Set(discovered.assets.map((file) => file.artifact)).size !== 5
  )
    throw new Error("Missing official/modified artifact coverage");

  for (const binary of discovered.binaries) {
    if (
      !binary.producers.some(
        (producer) => producer.name === "rustc" && producer.version.startsWith("1.99.1 "),
      ) ||
      !binary.producers.some(
        (producer) => producer.name === "wasm-bindgen" && producer.version.startsWith("0.2.129 "),
      )
    )
      throw new Error("Observed generator version changed");
  }

  return { audit, discovered, files };
}

if (import.meta.main) {
  const result = await checkContentAudit();
  console.log(
    `Verified ${result.audit.materials.length} content dispositions and ${result.audit.evidence.length} exact evidence files; deployable:false, fullNoticeAuditComplete:false. Technical evidence, not legal opinion.`,
  );
}
