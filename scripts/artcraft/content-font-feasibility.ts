import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  contentCorrespondence,
  parsePdfFontTable,
  pdfDecisionRoot,
} from "./content-correspondence.ts";
import { readAcquisitionFile } from "./content-delivery.ts";
import { inspectCffWidths } from "./content-cff-prefix.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

export const fontFeasibilityRoot = fileURLToPath(
  new URL("../../tooling/artcraft/font-data-feasibility/", import.meta.url),
);

const indexSha256 = "17a0e042f8e1041d6ae5cc208134d71b6e65559418a8720bf23f898183fd10b0";

const indexSchema = z.object({
  schemaVersion: z.literal(1),
  deployable: z.literal(false),
  fullNoticeAuditComplete: z.literal(false),
  compilerGeneratedNoticeAuditComplete: z.literal(false),
  protectedMarksCleared: z.literal(false),
  legalOpinion: z.literal(false),
  records: z.array(
    z.object({
      id: z.string(),
      member: z.string(),
      source: z.string(),
      path: relativePath,
      bytes: z.number(),
      sha256: digest,
    }),
  ),
});

export function pdfiumTable(source: string, name: string) {
  if (!/^[A-Za-z][A-Za-z0-9]+$/.test(name)) throw new Error("Invalid PDFium table name");

  const raw = source.match(
    new RegExp(`\\b${name}(?:\\[[^\\]]*\\])?\\s*=\\s*\\{([\\s\\S]*?)\\};`),
  )?.[1];

  if (!raw) throw new Error(`PDFium table missing: ${name}`);

  const tokens = raw
    .replace(/[{}]/g, "")
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean);

  return tokens.map((token) => {
    if (token === "nullptr") return null;

    if (/^"[^"\\]*"$/.test(token)) return z.string().parse(JSON.parse(token));

    if (/^(?:0x[0-9a-fA-F]+|\d+)$/.test(token)) return Number(token);
    throw new Error(`Unsupported PDFium table token in ${name}`);
  });
}

export function afmMetrics(source: string) {
  const glyphs = new Map<string, number>();
  const codes = new Map<number, string>();
  const declared = Number(source.match(/^StartCharMetrics (\d+)$/m)?.[1]);

  for (const line of source.split("\n")) {
    const match = line.match(/^C (-?\d+)\s*;\s*WX (-?\d+(?:\.\d+)?)\s*;\s*N ([^ ;]+)\s*;/);

    if (!match) continue;

    if (glyphs.has(match[3]!)) throw new Error("Duplicate AFM glyph");
    glyphs.set(match[3]!, Number(match[2]));

    if (Number(match[1]) >= 0) codes.set(Number(match[1]), match[3]!);
  }

  if (!Number.isInteger(declared) || glyphs.size !== declared)
    throw new Error("AFM metric count mismatch");

  return { glyphs, codes };
}

export async function fontDataFeasibility(root = fontFeasibilityRoot) {
  await contentCorrespondence();
  const indexBytes = await readAcquisitionFile(root, "index.json");

  if (sha256(indexBytes) !== indexSha256) throw new Error("Font feasibility index pin mismatch");
  const index = indexSchema.parse(JSON.parse(indexBytes.toString()));
  const files = new Map<string, Buffer>();

  for (const record of index.records) {
    if (files.has(record.id)) throw new Error("Duplicate font feasibility witness");
    const body = await readAcquisitionFile(root, record.path);

    if (body.length !== record.bytes || sha256(body) !== record.sha256)
      throw new Error(`Font feasibility source bytes changed: ${record.id}`);
    files.set(record.id, body);
  }

  function body(id: string) {
    const bytes = files.get(id);

    if (!bytes) throw new Error(`Font feasibility witness missing: ${id}`);

    return bytes;
  }

  const encodingSource = body("chromium/pdfium:core/fpdfapi/font/cpdf_fontencoding.cpp").toString();

  if (
    !encodingSource.startsWith("// Copyright 2016 The PDFium Authors") ||
    !encodingSource.slice(0, 300).includes("BSD-style license")
  )
    throw new Error("PDFium mapping source-specific licence changed");

  const afmPermission = body(
    "matplotlib/matplotlib:lib/matplotlib/mpl-data/fonts/pdfcorefonts/readme.txt",
  ).toString();

  if (
    !afmPermission.includes(
      "This file and the 14 PostScript(R) AFM files it accompanies may be used, copied,",
    ) ||
    !afmPermission.includes("with or without modification")
  )
    throw new Error("AFM companion permission missing");
  const stringsSource = body("read-fonts:src/ps/string.rs").toString();
  const stringsLiteral = stringsSource.match(/STANDARD_STRINGS:.*?=\s*&?(\[[\s\S]*?\n\]);/)?.[1];

  if (!stringsLiteral) throw new Error("CFF standard string witness missing");

  const standardStrings = z
    .array(z.string())
    .length(391)
    .parse(JSON.parse(stringsLiteral.replace(/,\s*\]/g, "]")));

  const widths = z
    .array(z.array(z.number()).length(256))
    .length(14)
    .parse(parsePdfFontTable(await readFile(join(pdfDecisionRoot, "0.txt")), "WIDTHS"));

  const encodingBody = await readFile(join(pdfDecisionRoot, "1.txt"));

  const existingEncodings = Object.fromEntries(
    ["WIN_ANSI", "MAC_ROMAN", "STANDARD"].map((name) => [
      name,
      z.array(z.number()).length(256).parse(parsePdfFontTable(encodingBody, name)),
    ]),
  );

  const winNames = z
    .array(z.string().nullable())
    .length(224)
    .parse(pdfiumTable(encodingSource, "kAdobeWinAnsiEncodingNames"));

  const mappingComparisons = [
    ["WIN_ANSI", "kAdobeWinAnsiEncoding"],
    ["MAC_ROMAN", "kMacRomanEncoding"],
    ["STANDARD", "kStandardEncoding"],
  ].map(([name, candidate]) => {
    const values = z.array(z.number()).length(256).parse(pdfiumTable(encodingSource, candidate!));

    const differences = values.flatMap((value, code) =>
      value === existingEncodings[name!]![code]
        ? []
        : [{ code, current: existingEncodings[name!]![code]!, pdfium: value }],
    );

    return {
      name,
      sourceTable: candidate,
      compared: 256,
      equal: 256 - differences.length,
      differences,
    };
  });

  const agl = body("adobe-agl-glyphlist").toString();

  if (!agl.includes("Redistribution and use in source and binary forms"))
    throw new Error("AGL data permission missing");

  const aglEntries = new Map(
    agl
      .split("\n")
      .filter((line) => !line.startsWith("#") && line.includes(";"))
      .map((line) => {
        const [name, value] = line.split(";");

        return [
          name!,
          value!
            .trim()
            .split(" ")
            .map((hex) => Number.parseInt(hex, 16)),
        ];
      }),
  );

  const currentNames = [
    ...encodingBody.toString().matchAll(/\("([^"]+)",\s*(0x[0-9a-fA-F]+|\d+)\)/g),
  ].map((match) => ({ name: match[1]!, value: Number(match[2]) }));

  const nameDifferences = currentNames.flatMap((entry) => {
    const candidate = aglEntries.get(entry.name);

    return candidate?.length === 1 && candidate[0] === entry.value
      ? []
      : [{ ...entry, agl: candidate ?? null }];
  });

  const joinedMappings = [
    ["WIN_ANSI", "kAdobeWinAnsiEncodingNames"],
    ["MAC_ROMAN", "kMacRomanEncodingNames"],
    ["STANDARD", "kStandardEncodingNames"],
  ].map(([name, candidate]) => {
    const names = z
      .array(z.string().nullable())
      .length(224)
      .parse(pdfiumTable(encodingSource, candidate!));

    const differences = Array.from({ length: 256 }, (_, code) => {
      const glyph = code < 32 ? null : names[code - 32];
      const mapped = glyph ? aglEntries.get(glyph) : undefined;
      const value = mapped?.length === 1 ? mapped[0]! : 0;

      return value === existingEncodings[name!]![code]
        ? null
        : { code, glyph, current: existingEncodings[name!]![code]!, pdfiumAndAgl: value };
    }).flatMap((entry) => (entry ? [entry] : []));

    return { name, sourceTable: candidate, equal: 256 - differences.length, differences };
  });

  const roman = await readAcquisitionFile(root, "apple-roman/ROMAN.txt");

  if (sha256(roman) !== "18e571645be895e9553ed5c842ea8f65f9c5d3c9ccb43e66e0c33a132ed0d721")
    throw new Error("Apple-Roman context snapshot changed");
  const appleRows = [...roman.toString().matchAll(/^0x([0-9A-Fa-f]+)\s+0x([0-9A-Fa-f]+)/gm)];

  const apple = new Map(
    appleRows.map((match) => [Number.parseInt(match[1]!, 16), Number.parseInt(match[2]!, 16)]),
  );

  const appleDifferences = Array.from({ length: 256 }, (_, code) => {
    const value = apple.get(code) ?? 0;

    return value === existingEncodings.MAC_ROMAN![code]
      ? []
      : [{ code, current: existingEncodings.MAC_ROMAN![code]!, apple: value }];
  }).flat();

  const fontNames = [
    "Helvetica",
    "Helvetica-Bold",
    "Helvetica-Oblique",
    "Helvetica-BoldOblique",
    "Times-Roman",
    "Times-Bold",
    "Times-Italic",
    "Times-BoldItalic",
    "Courier",
    "Courier-Bold",
    "Courier-Oblique",
    "Courier-BoldOblique",
    "Symbol",
    "ZapfDingbats",
  ];

  const fontInputs = [
    "Sans",
    "SansBold",
    "SansItalic",
    "SansBoldItalic",
    "Serif",
    "SerifBold",
    "SerifItalic",
    "SerifBoldItalic",
    "Fixed",
    "FixedBold",
    "FixedItalic",
    "FixedBoldItalic",
    "Symbol",
    "Dingbats",
  ];

  const fonts = fontNames.map((name, row) => {
    const afm = afmMetrics(body(`afm:${name}`).toString());
    const cff = inspectCffWidths(body(`font:${fontInputs[row]}`), standardStrings);
    const byName = new Map(cff.glyphs.map((glyph) => [glyph.name, glyph]));

    const checks = Array.from({ length: 256 }, (_, code) => {
      const rawName = row < 12 ? (code < 32 ? null : winNames[code - 32]) : afm.codes.get(code);
      // Explicit oracle policy for comparison only, never a replacement mapping: preserve the
      // current undefined WinAnsi slots instead of PDFium's bullet aliases for those slots.
      const glyphName = row < 12 && existingEncodings.WIN_ANSI![code] === 0 ? null : rawName;
      const glyph = glyphName ? byName.get(glyphName) : undefined;
      const afmWidth = glyphName ? (afm.glyphs.get(glyphName) ?? null) : 0;
      const cffWidth = glyphName ? (glyph?.width ?? null) : 0;

      return {
        code,
        glyphName: glyphName ?? null,
        current: widths[row]![code]!,
        afm: afmWidth,
        cff: cffWidth,
        reason: glyphName ? (glyph?.reason ?? "glyph-not-in-CFF") : "undefined-code-zero-policy",
        rawPdfiumAlias: rawName ?? null,
        cffWitness: glyph
          ? {
              gid: glyph.gid,
              charStringOffset: glyph.charStringOffset,
              leadingBytes: glyph.leadingBytes,
              proof: glyph.proof ?? null,
            }
          : null,
      };
    });

    return {
      name,
      input: `font:${fontInputs[row]}`,
      glyphs: cff.glyphs.length,
      afmGlyphs: afm.glyphs.size,
      afmGlyphNamesMissingFromCff: [...afm.glyphs.keys()].filter((glyph) => !byName.has(glyph)),
      decodedGlyphWidths: cff.glyphs.filter((glyph) => glyph.width !== null).length,
      unresolvedGlyphs: cff.glyphs.filter((glyph) => glyph.width === null),
      afmEqual: checks.filter((check) => check.afm === check.current).length,
      cffEqual: checks.filter((check) => check.cff === check.current).length,
      cffUnknown: checks.filter((check) => check.cff === null).length,
      afmDifferences: checks.filter((check) => check.afm !== check.current),
      cffDifferences: checks.filter((check) => check.cff !== null && check.cff !== check.current),
      cffUnresolvedCodes: checks.filter((check) => check.cff === null),
      undefinedCodePolicy: checks
        .filter((check) => check.reason === "undefined-code-zero-policy")
        .map((check) => check.code),
      pdfiumBulletAliasCodesExcluded:
        row < 12
          ? checks
              .filter((check) => check.glyphName === null && check.rawPdfiumAlias !== null)
              .map((check) => check.code)
          : [],
      defaultWidth: cff.defaultWidth,
      nominalWidth: cff.nominalWidth,
      matrix: cff.matrix,
    };
  });

  const helperIndex = await readAcquisitionFile(root, "font-helper-parser/index.json");

  if (sha256(helperIndex) !== "200d3f174f5a75b3c086e27a3683a00f14d6b048bf214b94fb9664948681aa00")
    throw new Error("Font-helper parser witness index changed");

  const helper = z
    .object({
      records: z.array(
        z.object({ member: z.string(), path: relativePath, bytes: z.number(), sha256: digest }),
      ),
    })
    .parse(JSON.parse(helperIndex.toString()));

  const helperFiles = new Map<string, Buffer>();

  for (const record of helper.records) {
    const bytes = await readAcquisitionFile(root, `font-helper-parser/${record.path}`);

    if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256)
      throw new Error("Font-helper parser witness bytes changed");
    helperFiles.set(record.member, bytes);
  }

  if (
    !helperFiles.get("crates/fonts/Cargo.toml")!.toString().includes('skrifa = "0.44"') ||
    !helperFiles
      .get("read-fonts-0.41.0/src/ps/cff/font.rs")!
      .toString()
      .includes("Result<Option<f32>, Error>") ||
    !helperFiles
      .get("skrifa-0.44.0/src/lib.rs")!
      .toString()
      .includes("pub extern crate read_fonts as raw;")
  )
    throw new Error("Actual font-helper parser boundary changed");

  const parserApi = body("read-fonts:src/ps/cff/font.rs").toString();

  if (
    !parserApi.includes("Result<Option<f32>, Error>") ||
    !parserApi.includes("width.map(|w| transform.transform_h_metric(w)")
  )
    throw new Error("Existing CFF width-return API changed");

  return {
    schemaVersion: 1,
    deployable: false,
    fullNoticeAuditComplete: false,
    compilerGeneratedNoticeAuditComplete: false,
    protectedMarksCleared: false,
    legalOpinion: false,
    method:
      "Static research only. Hash-verified AFM/mapping text plus bounded CFF1 literal-prefix decoding, including fixed literal subroutine references. No outline rendering or general arithmetic/branch evaluation; no vendor executable, Rust/C++ library or replacement table is run/emitted. Unknown prefixes remain unknown.",
    comparisonPolicy:
      "Text-face glyph names come from positively BSD-noticed PDFium names, with the frozen existing WinAnsi undefined-code mask used ONLY as an explicitly labelled comparison oracle. Symbol/Dingbats names use the permissively accompanied AFM built-in codes. This does not independently establish historical author inputs or settle mapping semantic policy.",
    permissionEvidence: {
      afm: "AFM-specific companion paragraph permits use/copy/distribution with or without modification, copyright retention, companion-file retention, prominent change notices and unchanged paragraph.",
      mappings:
        "PDFium mapping source explicitly points to BSD-style LICENSE; full source and LICENSE retained.",
      glyphNames:
        "Adobe AGL source carries its own complete BSD-style grant, conditions and disclaimer.",
    },
    existingDataBasis: {
      widths:
        "Positive AFM-specific permission evidence plus complete 3584-slot reproduction witness under the explicit comparison encoding policy. Do not require a width replacement solely because permission evidence was previously missing.",
      glyphNames:
        "The current 231 glyph-name entries have exact matching values in the independently BSD-permitted Adobe AGL input.",
      mappings:
        "BSD-noticed implementations exist. Standard is exactly equal; WinAnsi and MacRoman compatibility differences are explicit below, not silently adopted replacements.",
      historicalAuthorInputFilesEstablished: false,
      replacementSelected: false,
      note: "Supported technical existing-data evidence, not legal clearance; notice/provenance adoption and semantic-policy confirmation remain decisions.",
    },
    existingParser: {
      crate: "Hayro: read-fonts 0.44.0 via skrifa 0.47.0",
      fontHelperCrate:
        "pdfcraft-fonts: read-fonts 0.41.0 via its existing skrifa 0.44.0 dependency",
      fontHelperHasPublicWidthReturnApi: true,
      drawReturnsWidth: true,
      wrapperCurrentlyDiscardsResult: true,
      newProductionParserNecessary: false,
    },
    mappings: mappingComparisons,
    joinedMappings,
    appleRomanContext: {
      url: "https://www.unicode.org/Public/MAPPINGS/VENDORS/APPLE/ROMAN.TXT",
      sha256: sha256(roman),
      equal: 256 - appleDifferences.length,
      differences: appleDifferences,
      scope:
        "Historical semantic context only: the snapshot's own header is not an express redistribution grant. It documents the 1997 Omega canonical-decomposition update and 1998 euro update; no new licence conclusion is inferred.",
    },
    glyphNames: {
      compared: currentNames.length,
      equal: currentNames.length - nameDifferences.length,
      differences: nameDifferences,
    },
    fonts,
    totals: {
      comparedWidths: 14 * 256,
      afmEqual: fonts.reduce((sum, font) => sum + font.afmEqual, 0),
      cffEqual: fonts.reduce((sum, font) => sum + font.cffEqual, 0),
      cffUnknown: fonts.reduce((sum, font) => sum + font.cffUnknown, 0),
      cffDifferent: fonts.reduce((sum, font) => sum + font.cffDifferences.length, 0),
    },
  };
}

if (import.meta.main) {
  const [, , output] = process.argv;
  const bytes = Buffer.from(`${JSON.stringify(await fontDataFeasibility(), null, 2)}\n`);

  if (output) await writeFile(output, bytes, { flag: "wx" });
  else {
    if (!(await readFile(join(fontFeasibilityRoot, "result.json"))).equals(bytes))
      throw new Error("Font feasibility result differs from retained inputs");
    console.log(
      "Verified bounded font-data feasibility; no replacement selected and all clearance flags remain false.",
    );
  }
}
