import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cffLiteralWidth, inspectCffWidths } from "./content-cff-prefix.ts";
import {
  afmMetrics,
  fontDataFeasibility,
  fontFeasibilityRoot,
  pdfiumTable,
} from "./content-font-feasibility.ts";

test("literal-prefix decoder distinguishes explicit/default widths, stems and endchar without drawing", () => {
  expect(cffLiteralWidth(Buffer.from([239, 139, 22]), 600, 400).width).toBe(500);
  expect(cffLiteralWidth(Buffer.from([139, 22]), 600, 400).width).toBe(600);
  expect(cffLiteralWidth(Buffer.from([189, 149, 159, 1]), 600, 400).width).toBe(450);
  expect(cffLiteralWidth(Buffer.from([149, 159, 1]), 600, 400).width).toBe(600);
  expect(cffLiteralWidth(Buffer.from([239, 14]), 600, 400).width).toBe(500);
  expect(cffLiteralWidth(Buffer.from([14]), 600, 400).width).toBe(600);
});

test("fixed literal subroutine prefixes preserve stack values and return before outline data", () => {
  const program = Buffer.from([239, 139, 22, 255]);
  expect(cffLiteralWidth(Buffer.from([32, 10]), 600, 400, [program]).width).toBe(500);
  expect(cffLiteralWidth(Buffer.from([32, 29]), 600, 400, [], [program]).width).toBe(500);
  expect(cffLiteralWidth(Buffer.from([32, 10, 139, 22]), 600, 400, [Buffer.from([11])]).width).toBe(
    600,
  );
  expect(cffLiteralWidth(Buffer.from([32, 10]), 600, 400, [program]).proof?.operands).toEqual([
    100, 0,
  ]);
});

test("unsupported arithmetic, cycles, recursion and malformed data cannot silently yield widths", () => {
  expect(cffLiteralWidth(Buffer.from([139, 12, 10]), 600, 400).width).toBeNull();
  expect(cffLiteralWidth(Buffer.from([32, 10]), 600, 400, [Buffer.from([32, 10])]).reason).toBe(
    "cyclic-literal-prefix",
  );
  const chain = Array.from({ length: 12 }, (_, index) => Buffer.from([33 + index, 10]));
  expect(cffLiteralWidth(Buffer.from([32, 10]), 600, 400, chain).reason).toBe(
    "literal-prefix-subroutine-depth-limit",
  );
  expect(() => cffLiteralWidth(Buffer.from([28]), 600, 400)).toThrow("bounds");
  expect(() => cffLiteralWidth(Buffer.from([32, 10]), 600, 400)).toThrow("reference bounds");
  expect(() =>
    cffLiteralWidth(Buffer.from([...Array.from({ length: 49 }, () => 139), 22]), 600, 400),
  ).toThrow("stack limit");
  expect(() => inspectCffWidths(Buffer.alloc(1024 * 1024 + 1), [])).toThrow("size limit");
  expect(() => inspectCffWidths(Buffer.from([1, 0, 4, 1, 0, 1, 5]), [])).toThrow("offset size");
});

test("source table parsing is data-only and fails closed on unsupported tokens/counts", () => {
  expect(pdfiumTable('const AA = {{0x20, 0, nullptr, "space"}};', "AA")).toEqual([
    32,
    0,
    null,
    "space",
  ]);
  expect(() => pdfiumTable("const AA = {run_something()};", "AA")).toThrow("Unsupported");
  expect(() => pdfiumTable("", ".*")).toThrow("Invalid");
  expect(
    afmMetrics("StartCharMetrics 1\nC 32 ; WX 278 ; N space ; B 0 0 0 0 ;").glyphs.get("space"),
  ).toBe(278);
  expect(() => afmMetrics("StartCharMetrics 2\nC 32 ; WX 278 ; N space ;")).toThrow(
    "count mismatch",
  );
});

test("positive AFM-specific permission evidence reproduces the existing width data, not a replacement", async () => {
  const result = await fontDataFeasibility();
  expect(result.totals.afmEqual).toBe(3584);
  expect(result.fonts.every((font) => font.afmDifferences.length === 0)).toBe(true);
  expect(result.permissionEvidence.afm).toContain("with or without modification");
  expect(result.existingDataBasis.widths).toContain("Do not require a width replacement");
  expect(result.existingDataBasis.replacementSelected).toBe(false);
  expect(result.existingDataBasis.historicalAuthorInputFilesEstablished).toBe(false);
  expect(result.glyphNames).toEqual({ compared: 231, equal: 231, differences: [] });
  expect(result.deployable).toBe(false);
  expect(result.fullNoticeAuditComplete).toBe(false);
  expect(result.compilerGeneratedNoticeAuditComplete).toBe(false);
  expect(result.protectedMarksCleared).toBe(false);
  expect(result.legalOpinion).toBe(false);
  expect(JSON.parse(await readFile(join(fontFeasibilityRoot, "result.json"), "utf8"))).toEqual(
    result,
  );
});

test("all retained Foxit glyph widths decode but the numeric differences remain explicit", async () => {
  const result = await fontDataFeasibility();
  expect(result.totals).toEqual({
    comparedWidths: 3584,
    afmEqual: 3584,
    cffEqual: 3568,
    cffUnknown: 0,
    cffDifferent: 16,
  });
  expect(result.fonts.reduce((sum, font) => sum + font.decodedGlyphWidths, 0)).toBe(3210);
  expect(result.fonts.every((font) => font.unresolvedGlyphs.length === 0)).toBe(true);
  expect(result.fonts[0]!.afmGlyphNamesMissingFromCff.length).toBe(86);
  expect(result.fonts[8]!.afmGlyphNamesMissingFromCff.length).toBe(84);
  expect(result.fonts[12]!.afmGlyphNamesMissingFromCff.length).toBe(0);

  for (const difference of result.fonts.flatMap((font) => font.cffDifferences)) {
    const witness = difference.cffWitness;
    const proof = witness?.proof;

    if (!witness || !proof || difference.cff === null || !proof.operands.length)
      throw new Error("Expected a complete explicit-width witness for every numeric difference");
    expect(proof.nominalWidth + proof.operands[0]!).toBe(difference.cff);
    expect(witness.charStringOffset).toBeGreaterThan(0);
  }

  expect(result.fonts[0]!.cffDifferences.find((row) => row.code === 128)).toMatchObject({
    current: 556,
    cff: 667,
    glyphName: "Euro",
  });
  expect(result.existingParser).toMatchObject({
    drawReturnsWidth: true,
    fontHelperHasPublicWidthReturnApi: true,
    wrapperCurrentlyDiscardsResult: true,
    newProductionParserNecessary: false,
  });
});

test("BSD PDFium mapping candidates are not silently treated as semantically identical", async () => {
  const result = await fontDataFeasibility();
  expect(result.mappings.map((mapping) => mapping.equal)).toEqual([250, 239, 256]);
  expect(result.joinedMappings.map((mapping) => mapping.equal)).toEqual([250, 254, 256]);
  expect(result.mappings[0]!.differences.map((row) => row.code)).toEqual([
    127, 129, 141, 143, 144, 157,
  ]);
  expect(result.joinedMappings[1]!.differences.map((row) => row.code)).toEqual([189, 219]);
  expect(result.appleRomanContext.differences).toEqual([{ code: 202, current: 32, apple: 160 }]);
  expect(result.appleRomanContext.scope).toContain("not an express redistribution grant");
});

test("tampering or missing pinned research/permission bytes fails without altering the frozen audit", async () => {
  const root = await mkdtemp(join(tmpdir(), "hyori-font-feasibility-"));

  try {
    await cp(fontFeasibilityRoot, root, { recursive: true });
    const source = join(root, "39.txt");
    const original = await readFile(source);
    await writeFile(source, Buffer.concat([original, Buffer.from("changed")]));
    await expect(fontDataFeasibility(root)).rejects.toThrow("source bytes changed");
    await rm(source);
    await expect(fontDataFeasibility(root)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
