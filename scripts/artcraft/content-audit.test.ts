import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkContentAudit, contentRoot, contentIndexSchema } from "./content-audit.ts";
import { sourceNoticePrefix, contentNoticeFiles } from "./content-notices.ts";
import { sha256 } from "./evidence-bytes.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hyori-content-audit-"));

  for (const name of ["index.json", "manifest.json", "discovery.json", "evidence"])
    await cp(join(contentRoot, name), join(root, name), { recursive: true });

  return root;
}

async function manifest(root: string, bytes: Buffer) {
  const index = contentIndexSchema.parse(
    JSON.parse(await readFile(join(root, "index.json"), "utf8")),
  );

  await writeFile(join(root, index.manifest.path), bytes);
  index.manifest.sha256 = sha256(bytes);
  await writeFile(join(root, "index.json"), JSON.stringify(index));
}

test("bounded content audit covers every discovered official/modified item, not legal clearance", async () => {
  const { audit, discovered } = await checkContentAudit();
  expect(discovered.assets.length).toBe(68);
  expect(discovered.binaries.reduce((sum, binary) => sum + binary.fonts.length, 0)).toBe(54);
  expect(audit.materials.length).toBe(5568);
  expect(audit.deployable).toBe(false);
  expect(audit.fullNoticeAuditComplete).toBe(false);
  expect(audit.legalOpinion).toBe(false);
});

test("removing both a material and its claimed ID cannot weaken discovery coverage", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);
    const removed = audit.materials.find((material) => material.category === "embedded-font")!.id;
    audit.materials = audit.materials.filter((material) => material.id !== removed);
    audit.scope.discoveredItemIds = audit.scope.discoveredItemIds.filter((id) => id !== removed);
    await manifest(root, Buffer.from(JSON.stringify(audit)));
    await expect(checkContentAudit(root)).rejects.toThrow("coverage disposition");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("metadata alone cannot substitute for a font permission body", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);
    const font = audit.materials.find((material) => material.category === "embedded-font")!;
    font.evidence = font.evidence.filter(
      (id) => audit.evidence.find((file) => file.id === id)?.role !== "permission-text",
    );
    await manifest(root, Buffer.from(JSON.stringify(audit)));
    await expect(checkContentAudit(root)).rejects.toThrow("complete permission-text");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("compiler-builtins conjunction cannot be replaced by the Rust umbrella choice", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);
    const runtime = audit.materials.find((material) => material.id === "runtime:rust-1.99.1")!;
    runtime.evidence = runtime.evidence.filter(
      (id) =>
        audit.evidence.find((file) => file.id === id)?.member !==
        "rust-library_compiler-builtins_LICENSE.txt",
    );
    await manifest(root, Buffer.from(JSON.stringify(audit)));
    await expect(checkContentAudit(root)).rejects.toThrow("conjunction/exception");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("project SPDX labels cannot silently clear Adobe-derived metric rights", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);
    audit.materials.find((material) =>
      material.id.endsWith("fonts/src/std14_metrics.rs"),
    )!.disposition = "notice-evidence-reviewed";
    await manifest(root, Buffer.from(JSON.stringify(audit)));
    await expect(checkContentAudit(root)).rejects.toThrow("Adobe-derived data rights");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed content evidence and false full-audit flags fail independently", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);
    const item = audit.evidence.find((file) => file.scope === "audit")!;
    const path = join(root, item.path);
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed")]));
    await expect(checkContentAudit(root)).rejects.toThrow("checksum mismatch");
    await writeFile(path, original);
    await manifest(root, Buffer.from(JSON.stringify({ ...audit, fullNoticeAuditComplete: true })));
    await expect(checkContentAudit(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice supplement preserves exact condition bytes and does not claim deployment", async () => {
  const { audit, files } = await checkContentAudit();
  const notices = await contentNoticeFiles();

  for (const evidence of audit.evidence)
    if (evidence.role === "permission-text")
      expect(notices.get(`conditions/${evidence.id}.txt`)).toEqual(files.get(evidence.id));
  expect(notices.get("notice-manifest.json")?.toString()).toContain('"deployable": false');
  expect(notices.get("notice-manifest.json")?.toString()).toContain('"incomplete": []');

  for (const member of ["rem_pio2_large.rs", "erf.rs"]) {
    const evidence = audit.evidence.find((file) => file.member.endsWith(`/math/${member}`))!;
    expect(notices.get(`runtime-source-notices/${evidence.id}.txt`)?.toString()).toContain(
      "provided that this notice",
    );
  }
});

test("copied eframe JS requires its exact source literal, not just a generic app licence", async () => {
  const root = await fixture();

  try {
    const { audit } = await checkContentAudit(root);

    const material = audit.materials.find(
      (material) =>
        material.id.startsWith("asset:wordcraft@") && material.id.endsWith("/inline0.js"),
    )!;

    material.evidence = material.evidence.filter(
      (id) =>
        audit.evidence.find((file) => file.id === id)?.member !==
        "crates/eframe/src/web/text_agent.rs",
    );
    await manifest(root, Buffer.from(JSON.stringify(audit)));
    await expect(checkContentAudit(root)).rejects.toThrow("eframe snippet source proof");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("leading source notices preserve nested comments and exclude code", () => {
  const text = Buffer.from("// Copyright A\n/* terms /* nested */ end */\nfn code() {}\n");
  expect(sourceNoticePrefix(text).toString()).toBe(
    "// Copyright A\n/* terms /* nested */ end */\n",
  );
  expect(() => sourceNoticePrefix(Buffer.from("/* unfinished"))).toThrow("Truncated");
});
