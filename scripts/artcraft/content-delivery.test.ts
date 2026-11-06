import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDeliveryFiles, noticeRoot } from "./content-delivery.ts";
import { contentNoticeFiles } from "./content-notices.ts";
import { checkContentAudit } from "./content-audit.ts";
import { contentCorrespondence, pdfDecisionRoot } from "./content-correspondence.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hyori-notice-delivery-"));
  await cp(noticeRoot, root, { recursive: true });

  return root;
}

test("delivery preserves all 130 generated files plus whole source attributions and an intelligible index", async () => {
  const delivery = await contentDeliveryFiles();
  const generated = await contentNoticeFiles();

  for (const [path, body] of generated)
    expect(delivery.files.get(`legal/content/${path}`)).toEqual(body);
  const { audit, files } = await checkContentAudit();

  for (const evidence of audit.evidence.filter((file) =>
    /ATTRIBUTION|NOTICE|COPYRIGHT|AUTHORS|ACKNOWLEDG/i.test(file.member),
  ))
    expect(delivery.files.get(`legal/content-source-notices/${evidence.id}.txt`)).toEqual(
      files.get(evidence.id),
    );
  expect(delivery.files.size).toBe(173);
  expect(delivery.files.get("legal/NOTICE-INDEX.md")!.toString()).toContain("historical snapshot");
  expect(delivery.files.get("legal/content-coverage.json")!.toString()).toContain(
    '"legalOpinion": false',
  );
});

test("a changed permission body fails the pinned delivery check", async () => {
  const root = await fixture();

  try {
    const path = join(root, "files/conditions/e0.txt");
    const original = await readFile(path);
    await writeFile(path, Buffer.concat([original, Buffer.from("changed")]));
    await expect(contentDeliveryFiles(root)).rejects.toThrow("checksum/evidence mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("missing notice bytes and removing their index entry both fail independently", async () => {
  const root = await fixture();

  try {
    const path = join(root, "files/conditions/e0.txt");
    await readFile(path);
    await rm(path);
    await expect(contentDeliveryFiles(root)).rejects.toThrow();
    const index = await readFile(join(root, "index.json"), "utf8");
    await writeFile(
      join(root, "index.json"),
      index.replace('"conditions/e0.txt"', '"conditions/removed.txt"'),
    );
    await expect(contentDeliveryFiles(root)).rejects.toThrow("index pin mismatch");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("notice-directory links and unaccounted extra files are rejected", async () => {
  const root = await fixture();

  try {
    const extra = join(root, "files/unaccounted.txt");
    await writeFile(extra, "unexpected");
    await expect(contentDeliveryFiles(root)).rejects.toThrow("Unaccounted");
    await rm(extra);
    const target = join(root, "files/conditions/e0.txt");
    await readFile(target);
    await rm(target);
    await symlink(join(noticeRoot, "files/conditions/e0.txt"), target);
    await expect(contentDeliveryFiles(root)).rejects.toThrow("not links");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("retained correspondence resolves declared versions and exact data shapes, not data rights", async () => {
  const result = await contentCorrespondence();
  expect(result.pdfcraft.fontFaces).toBe(14);
  expect(result.pdfcraft.codesPerFace).toBe(256);
  expect(result.pdfcraft.encodingLengths).toEqual({ WIN_ANSI: 256, MAC_ROMAN: 256, STANDARD: 256 });
  expect(Object.values(result.pdfcraft.semanticChecks).every(Boolean)).toBe(true);
  expect(result.versionDeclarations.some((row) => row.declaration.includes("18, 0, 0"))).toBe(true);
  expect(result.versionDeclarations.some((row) => row.declaration.includes("48.2.1"))).toBe(true);
  expect(
    result.identicalSourceGroups.some((group) =>
      group.sources.some((source) => source.member.endsWith("numbers.postcard")),
    ),
  ).toBe(true);
  expect(result.pdfcraft.disposition).toContain("unresolved-source-rights");
  expect(result.deployable).toBe(false);
  expect(JSON.parse(await readFile(join(pdfDecisionRoot, "correspondence.json"), "utf8"))).toEqual(
    result,
  );
});
