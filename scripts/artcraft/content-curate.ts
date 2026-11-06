import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { checkClosureEvidence } from "./closure.ts";
import { checkRedistributionEvidence } from "./redistribution.ts";
import {
  discoverySchema,
  fetchRecord,
  rustSourceSchema,
  auditSchema,
  type Material,
  evidenceSchema,
} from "./content-schema.ts";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { readCrateArchive, readGitSourceArchive, sha256 } from "./evidence-bytes.ts";
import { inspectWasm } from "./content-binary.ts";
import { validateZipArchive, expandZipEntry } from "./validated-zip.ts";
import official from "../../tooling/artcraft/manifest.json" with { type: "json" };

const [, , discoveryPath, publicConfig, upstreamOne, upstreamTwo, rustDirectory, destination] =
  process.argv;

if (
  !discoveryPath ||
  !publicConfig ||
  !upstreamOne ||
  !upstreamTwo ||
  !rustDirectory ||
  !destination ||
  process.argv.length !== 8
)
  throw new Error(
    "Usage: bun scripts/artcraft/content-curate.ts DISCOVERY PUBLIC_CONFIG UPSTREAM_ONE UPSTREAM_TWO RUST_SOURCE_EVIDENCE NEW_OUTPUT",
  );

const discovery = discoverySchema.parse(JSON.parse(await readFile(discoveryPath, "utf8")));

const config = z
  .object({
    publicCargoCache: z.string(),
    editors: z.array(
      z.object({ app: z.string(), sourceArchive: z.string(), releaseArchive: z.string() }),
    ),
  })
  .parse(JSON.parse(await readFile(publicConfig, "utf8")));

const rust = rustSourceSchema.parse(
  JSON.parse(await readFile(join(rustDirectory, "source.json"), "utf8")),
);

const closure = await checkClosureEvidence();
const legacy = await checkRedistributionEvidence();

for (const [path, bytes] of closure.files) legacy.set(`closure/${path}`, bytes);

const output = resolve(destination);

await mkdir(output);

await mkdir(join(output, "evidence"));

const evidence: z.infer<typeof evidenceSchema>[] = [];
const materials: Material[] = [];
const upstreams = new Map<string, { path: string; url: string; sha256: string; bytes: number }>();
const networkFailures: { id: string; url: string; error: string }[] = [];

for (const directory of [upstreamOne, upstreamTwo]) {
  const sources = fetchRecord.parse(
    JSON.parse(await readFile(join(directory, "sources.json"), "utf8")),
  );

  networkFailures.push(...sources.failures);

  for (const file of sources.files)
    upstreams.set(file.id, { ...file, path: join(directory, file.path) });
}

async function retain(
  bytes: Buffer,
  role: z.infer<typeof evidenceSchema>["role"],
  source: string,
  member: string,
) {
  const hash = sha256(bytes);
  const previous = evidence.find((file) => file.sha256 === hash && file.role === role);

  if (previous) return previous.id;

  const existing = [...legacy].find(
    ([path, body]) =>
      (path.startsWith("licenses/") || path.startsWith("closure/legal/")) && body.equals(bytes),
  );

  const id = `e${evidence.length}`;
  const path = existing ? existing[0] : `evidence/${id}.txt`;

  if (!existing) await writeFile(join(output, path), bytes, { flag: "wx" });
  evidence.push({
    id,
    scope: existing ? "legacy" : "audit",
    path,
    bytes: bytes.length,
    sha256: hash,
    role,
    source,
    member,
  });

  return id;
}

const treeCache = new Map<string, Map<string, Buffer>>();

async function sourceFile(sourceId: string, member: string): Promise<Buffer> {
  const already = closure.manifest.files.find(
    (file) => file.source === sourceId && file.member === member && file.transform === "identity",
  );

  if (already) return closure.files.get(already.path)!;
  const source = closure.manifest.sources.find((source) => source.id === sourceId);

  if (!source) throw new Error(`Unknown content source ${sourceId}`);
  const cached = treeCache.get(sourceId);

  if (cached) {
    const bytes = cached.get(member);

    if (!bytes) throw new Error(`Missing member ${member}`);

    return bytes;
  }

  const app = config.editors.find((entry) => `${entry.app}-source` === sourceId);

  if (app || source.kind === "crate") {
    const pkg = closure.manifest.packages.find((pkg) => pkg.sourcePin === sourceId)!;

    const archive = await readFile(
      app?.sourceArchive ??
        join(
          config.publicCargoCache,
          "registry/cache/index.crates.io-1949cf8c6b5b557f",
          `${pkg.name}-${pkg.version}.crate`,
        ),
    );

    if (sha256(archive) !== source.sha256) throw new Error(`Source checksum changed ${sourceId}`);

    const tree = app
      ? readGitSourceArchive(archive, source.root!, source.commit!)
      : readCrateArchive(archive, source.root!);

    treeCache.set(sourceId, tree);
    const bytes = tree.get(member);

    if (!bytes) throw new Error(`Missing source member ${sourceId}:${member}`);

    return bytes;
  }

  const github = source.url.match(
    /^https:\/\/codeload.github.com\/([^/]+\/[^/]+)\/tar.gz\/([a-f0-9]{40})$/,
  );

  if (!github) throw new Error(`No immutable member URL ${sourceId}`);

  const expected = discovery.references.find(
    (reference) => reference.source === sourceId && reference.member === member,
  )?.sha256;

  return fetchBuildInput(
    `https://raw.githubusercontent.com/${github[1]}/${github[2]}/${member.split("/").map(encodeURIComponent).join("/")}`,
    expected,
    8 * 1024 * 1024,
  );
}

async function sourceEvidence(
  source: string,
  member: string,
  role: z.infer<typeof evidenceSchema>["role"] = "permission-text",
) {
  return retain(await sourceFile(source, member), role, source, member);
}

async function upstreamEvidence(
  id: string,
  role: z.infer<typeof evidenceSchema>["role"] = "permission-text",
) {
  const file = upstreams.get(id);

  if (!file) throw new Error(`Required upstream evidence missing: ${id}`);
  const bytes = await readFile(file.path);

  if (sha256(bytes) !== file.sha256) throw new Error(`Fetched evidence changed: ${id}`);

  return retain(bytes, role, file.url, id);
}

const policies: { id: string; text: string; evidence: string[] }[] = [];

function policy(id: string, text: string, refs: string[]) {
  policies.push({ id, text, evidence: refs });
}

const rustMit = await upstreamEvidence("rust-LICENSE-MIT");
const rustApache = await upstreamEvidence("rust-LICENSE-APACHE");
const rustUnicode = await upstreamEvidence("rust-LICENSES_Unicode-3.0.txt");
const builtins = await upstreamEvidence("rust-library_compiler-builtins_LICENSE.txt");
const libm = await upstreamEvidence("rust-library_compiler-builtins_libm_LICENSE.txt");
const rustReuse = await upstreamEvidence("rust-REUSE.toml", "provenance");

policy(
  "rust-stdlib",
  "Rust root MIT OR Apache is not a blanket licence for every runtime input. The exact core Unicode data annotation is Unicode-3.0; preserve that copyright/permission body too. The source component is checksum matched to Rust 1.99.1 and the observed producer/source commit, not a per-object link attestation.",
  [rustMit, rustApache, rustUnicode, rustReuse],
);

policy(
  "compiler-builtins",
  "The actual compiler-builtins declaration is MIT AND Apache-2.0 WITH LLVM-exception. The embedded-object exception waives Apache 4(a), 4(b), 4(d) in its stated circumstances, not MIT obligations. Preserve complete texts, pre-2019 compiler-rt credit statement, libm/musl/CORE-MATH attributions and per-file clauses; do not reduce AND to OR.",
  [builtins, libm],
);

const generatorRefs = [
  await upstreamEvidence("wasm-bindgen-LICENSE-MIT"),
  await upstreamEvidence("wasm-bindgen-LICENSE-APACHE"),
  await upstreamEvidence("trunk-LICENSE-MIT"),
  await upstreamEvidence("trunk-LICENSE-APACHE"),
  await upstreamEvidence("binaryen-LICENSE"),
];

const generatorSources = [
  await upstreamEvidence("wasm-bindgen-crates_cli-support_src_js_mod.rs", "generator-source"),
  await upstreamEvidence("trunk-output.rs", "generator-source"),
  await upstreamEvidence("trunk-src_pipelines_rust_mod.rs", "generator-source"),
];

policy(
  "generated-web-output",
  "wasm-bindgen generates copied JavaScript glue and may preserve dependency snippets; Trunk injects its own loader template and copies snippets. Retain source-matched permission/attribution for copied code. Binaryen/Walrus are transformations, not automatically shipped runtime libraries: no claim that all tool dependencies license the output. The reviewed recipe is -Oz without requested Asyncify/instrumentation; exact official optimizer provenance remains unverified.",
  [...generatorRefs, ...generatorSources],
);

const mitCondition =
  "Retain the actual copyright and complete MIT permission/disclaimer; an SPDX label alone is insufficient.";

policy("mit", mitCondition, [rustMit]);

policy(
  "ofl",
  "SIL OFL 1.1 requires copyright plus licence with redistributed fonts, no sale of a font by itself, retention of font licensing and reserved-name rules for modified fonts. A software bundle is distinct from selling the font by itself. Font-document output is not thereby OFL-licensed; no trademark permission is inferred.",
  [],
);

policy(
  "ufl",
  "Ubuntu Font Licence 1.0 requires copyright/licence in each copy, original names for original versions, its specific naming rules for modified versions and no trademark grant. Byte/source identity here is evidence, not approval for a later renamed/subsetted font.",
  [],
);

policy(
  "hack",
  "Hack combines Source Foundry MIT with Bitstream Vera terms and a DejaVu public-domain statement; retain all, including reserved names and the no-standalone-font-sale condition.",
  [],
);

policy(
  "bsd",
  "BSD/WHATWG/Foxit/Adobe data notices require copyright, conditions and disclaimer in binary-distribution documentation/materials and prohibit implying endorsement. NOTICE mentioning BSD without its actual terms is not a substitute.",
  [],
);

policy(
  "unicode",
  "Unicode data/ICU/CLDR terms are distinct from surrounding MIT/Apache code. Preserve data copyright/permission, ICU4C/ICU4J/IBM adaptation notices where present, and check data/version provenance rather than granting rights from the generator's licence.",
  [rustUnicode],
);

policy(
  "cc0",
  "CC0 includes a dedication and fallback licence; preserve exact producer/source statements and full text. Root MIT/Apache does not establish rights in an ICC profile or input dictionary. No trademark/patent clearance is implied.",
  [],
);

policy(
  "adobe-metrics-unresolved",
  "PdfCraft labels Adobe Core14/ISO-derived metric and encoding tables MIT/Apache, but a project policy or self-assigned SPDX expression does not establish rights in its upstream source data. Exact upstream permissions/dataset provenance must be demonstrated or the material replaced by its owner.",
  [],
);

policy(
  "marks",
  "ArtCraft brand terms expressly distinguish trademark permission from repository copyright licensing and require removal/replacement for distributed modified builds. This audit does not alter marks or clear the gate.",
  [],
);

const bySource = new Map(discovery.references.map((reference) => [reference.id, reference]));

for (const member of ["crates/fonts/src/std14_metrics.rs", "crates/fonts/src/encodings.rs"]) {
  const id = `pdfcraft-source:${member}`;

  if (!bySource.has(id)) {
    const bytes = await sourceFile("pdfcraft-source", member);
    bySource.set(id, {
      id,
      source: "pdfcraft-source",
      member,
      sha256: sha256(bytes),
      bytes: bytes.length,
      kind: "manual-content-review",
      matches: [],
      header: bytes.subarray(0, 12000).toString(),
    });
  }
}

const i18nRefs = [
  await upstreamEvidence("wordcraft-craft-i18n-LICENSE-MIT"),
  await upstreamEvidence("wordcraft-craft-i18n-LICENSE-APACHE"),
  await upstreamEvidence("wordcraft-craft-i18n-ATTRIBUTION.md", "copyright-source"),
];

const catalogCommit = "9205108cfdced5177706264038848b68b2422d2b";
const catalogUrl = `https://codeload.github.com/storytold/craft-i18n/tar.gz/${catalogCommit}`;
const catalogArchive = await fetchBuildInput(catalogUrl, undefined, 16 * 1024 * 1024);
const catalogs = readGitSourceArchive(catalogArchive, `craft-i18n-${catalogCommit}`, catalogCommit);

discovery.sources.push({
  id: "wordcraft-craft-i18n",
  url: catalogUrl,
  sha256: sha256(catalogArchive),
  bytes: catalogArchive.length,
});

const wordPin = official.editors.find((editor) => editor.app === "wordcraft")!;

const wordZip = await readFile(
  config.editors.find((editor) => editor.app === "wordcraft")!.releaseArchive,
);

if (sha256(wordZip) !== wordPin.sha256) throw new Error("Word distribution checksum mismatch");

const wordWasm = validateZipArchive(wordZip, wordPin.archiveRoot, official.limits).find((file) =>
  file.path.endsWith(".wasm"),
)!;

const wordMemory = inspectWasm(expandZipEntry(wordWasm)).memory;

for (const [member, bytes] of catalogs) {
  if (!/^locales\/[^/]+\/(?:common|wordcraft)\.tsv$/.test(member)) continue;
  const offset = wordMemory.indexOf(bytes);
  const id = `wordcraft-craft-i18n:${member}`;
  bySource.set(id, {
    id,
    source: "wordcraft-craft-i18n",
    member,
    bytes: bytes.length,
    sha256: sha256(bytes),
    kind: "external-translation-catalog",
    matches: offset >= 0 ? [{ artifact: "wordcraft@0.14.0", offset }] : [],
  });
}

const references = [...bySource.values()];
const fontCopies: string[] = [];

for (const binary of discovery.binaries)
  for (const font of binary.fonts) {
    const name = font.names.find((name) => name.id === 1)?.text ?? "unnamed";

    const metadata = await retain(
      Buffer.from(`${JSON.stringify(font, null, 2)}\n`),
      "font-metadata",
      binary.artifact,
      `WASM memory ${font.offset}`,
    );

    const source = references.find((reference) => reference.font?.sha256 === font.sha256);
    let notice: string;
    let rule = "ofl";
    let provenance = metadata;

    if (/Hack/.test(name)) {
      notice = await sourceEvidence(
        "git-storytold-egui-6d518fc799681571963842f95b55a6b68431b15a",
        "crates/epaint_default_fonts/fonts/Hack-Regular.txt",
      );
      rule = "hack";
    } else if (/Ubuntu/.test(name)) {
      notice = await sourceEvidence(
        "git-storytold-egui-6d518fc799681571963842f95b55a6b68431b15a",
        "crates/epaint_default_fonts/fonts/UFL.txt",
      );
      rule = "ufl";
    } else if (/Noto Emoji/.test(name))
      notice = await sourceEvidence(
        "git-storytold-egui-6d518fc799681571963842f95b55a6b68431b15a",
        "crates/epaint_default_fonts/fonts/OFL.txt",
      );
    else if (name === "emoji") {
      notice = await sourceEvidence(
        "git-storytold-egui-6d518fc799681571963842f95b55a6b68431b15a",
        "crates/epaint_default_fonts/fonts/emoji-icon-font-mit-license.txt",
      );
      rule = "mit";
    } else if (/Georgian/.test(name)) {
      const matched = z
        .object({ sha256: z.string() })
        .parse(
          JSON.parse(await readFile(join(upstreamOne, "georgian-font-metadata.json"), "utf8")),
        );

      if (matched.sha256 !== font.sha256)
        throw new Error("Georgian font source does not match embedded table extent");
      notice = await upstreamEvidence("craft-fonts-georgian-OFL");
      provenance = await upstreamEvidence("craft-fonts-fonts_manifest.txt", "provenance");
    } else {
      if (!source) throw new Error(`Unmapped font: ${name}`);
      let family = "Inter";

      if (/Source Sans/.test(name)) family = "SourceSans3";

      if (/Source Serif/.test(name)) family = "SourceSerif4";

      if (/JetBrains/.test(name)) family = "JetBrainsMono";

      if (/Dancing/.test(name)) family = "DancingScript";

      const sourceApp = source.source.endsWith("-source")
        ? source.source
        : binary.artifact.split("@")[0] + "-source";

      notice = await sourceEvidence(sourceApp, `assets/fonts/OFL-${family}.txt`);
    }

    fontCopies.push(
      `${binary.artifact} memory ${font.offset}; ${name}; sfnt table extent SHA-256 ${font.sha256}\n${font.names
        .filter((name) => [0, 13, 14].includes(name.id))
        .map((name) => name.text)
        .join("\n")}\n`,
    );
    materials.push({
      id: `font:${binary.artifact}:${font.offset}`,
      category: "embedded-font",
      artifacts: [binary.artifact],
      disposition: "notice-evidence-reviewed",
      evidence: [metadata, notice, provenance],
      obligations: [rule, "retain-exact-font-copyright"],
      assessment: `Actual sfnt tables, names and copyright/licence metadata reviewed. ${source ? `Table extent matches ${source.id}.` : "Georgian extent matches the separately pinned craft-fonts input."} Full source-file padding is not treated as part of the sfnt-table extent. ${name === "emoji" ? "Subset and parent face share the pinned John Slegers notice; that is not a trademark grant for depicted logos." : ""}`,
      remaining: [
        "Original upstream ZIPs do not all ship these full notices/copyrights; the acquisition supplements and this separately retained content notice pack must accompany redistribution.",
      ],
    });
  }

await retain(
  Buffer.from(fontCopies.join("\n")),
  "copyright-source",
  "actual-five-WASM-binaries",
  "embedded-font-copyrights",
);

const unicodeLicense = closure.manifest.files.find((file) =>
  file.path.endsWith("icu_properties_data-2.3.0-07dd721bc738e7b9/LICENSE"),
)!;

const unicodeEvidence = await retain(
  closure.files.get(unicodeLicense.path)!,
  "permission-text",
  unicodeLicense.source,
  unicodeLicense.member!,
);

const cc0Path = [...legacy].find(([path]) => /CC0/i.test(path))?.[0];

if (!cc0Path) throw new Error("No retained CC0 permission body");

const cc0 = await retain(
  legacy.get(cc0Path)!,
  "permission-text",
  "earlier-verified-CC0-evidence",
  cc0Path,
);

const pdfAttribution = await sourceEvidence("pdfcraft-source", "ATTRIBUTION.toml", "provenance");

for (const reference of references) {
  const refs: string[] = [];
  const rules: string[] = [];
  let disposition: Material["disposition"] = "unresolved";

  let assessment =
    "A discovered source candidate is not proof of inclusion or absence after code generation, compression, subsetting or optimization.";

  const remaining: string[] = [];
  const member = reference.member;
  const artifacts = reference.matches.map((match) => match.artifact);

  if (reference.source === "wordcraft-craft-i18n") {
    refs.push(...i18nRefs);
    rules.push("mit");
    disposition = "notice-evidence-reviewed";
    assessment =
      "External translation TSV is resolved to the editor's immutable craft-i18n.rev, fully path-validated source archive and exact binary byte observation where present. Shared/app catalog copyrights and translator attribution are retained with MIT/Apache terms.";

    if (!reference.matches.length)
      remaining.push("This catalog candidate was not byte-observed; no absence assertion is made.");
  } else if (reference.font) {
    disposition = "conservative-notice-evidence";
    rules.push("ofl", "ufl", "hack", "mit");
    assessment =
      "Font source candidate; actual embedded faces are separately individually resolved by sfnt extent and metadata. No byte match is used to claim this candidate absent.";
  } else if (
    member.startsWith("assets/icons/") &&
    member.endsWith(".svg") &&
    reference.source === "pdfcraft-source"
  ) {
    refs.push(await sourceEvidence("pdfcraft-source", "assets/icons/LICENSE-lucide.txt"));
    rules.push("mit", "ISC-copyright-permission-and-disclaimer");
    disposition = "notice-evidence-reviewed";
    assessment =
      "Actual SVG bytes are present in PdfCraft WASM. Lucide ISC and the included Feather-derived icon list/MIT terms were read; preserve both complete licence sections and their distinct copyright notices.";
  } else if (member.includes("docs/brand/")) {
    refs.push(await sourceEvidence(reference.source, "docs/brand/LICENSE-brand.txt"));
    rules.push("marks");
    disposition = "protected-mark-gate";
    assessment =
      "Exact ArtCraft SVG bytes discovered in released WASM; copyright root licences do not erase the separate brand restrictions.";
    remaining.push(
      "Brand owner must resolve modified-build distribution context and protected marks; no image/UI changes made here.",
    );
  } else if (member.endsWith("std14_metrics.rs") || member.endsWith("fonts/src/encodings.rs")) {
    refs.push(pdfAttribution, await sourceEvidence(reference.source, member, "copyright-source"));
    rules.push("adobe-metrics-unresolved");
    assessment =
      "Source explicitly attributes Adobe Core14 AFM/specification-derived technical data. Its own MIT/Apache label is insufficient upstream rights evidence.";
    remaining.push(
      "Obtain exact upstream AFM/specification data permission and transformation provenance, or an independently licensed replacement; do not infer clearance from project AGENTS policy.",
    );
  } else if (member.includes("Foxit") && member.endsWith(".pfb")) {
    refs.push(
      await sourceEvidence(reference.source, member.replace(/Foxit[^/]+\.pfb$/, "LICENSE_FOXIT")),
    );
    rules.push("bsd");
    disposition = "notice-evidence-reviewed";
    assessment =
      "Exact Foxit/PDFium Type1 bytes occur in WASM. The asset-specific BSD-3 notice names PDFium 2014 and original Foxit code; this is separate from surrounding hayro MIT/Apache.";
  } else if (member.endsWith("cmaps.brotli")) {
    refs.push(
      await sourceEvidence(reference.source, member.replace("cmaps.brotli", "LICENSE.txt")),
    );
    rules.push("bsd");
    disposition = "notice-evidence-reviewed";
    assessment =
      "Exact compressed Adobe CMap data bytes occur in WASM. Preserve the complete Adobe 1990-2023 BSD-3 copyright, conditions and disclaimer; a product NOTICE summary is insufficient by itself.";
  } else if (member.endsWith(".icc")) {
    rules.push("cc0");
    refs.push(cc0);
    disposition = "conservative-notice-evidence";

    if (member.includes("krilla/icc/")) {
      refs.push(await sourceEvidence(reference.source, "licenses/pdf-writer/LICENSE-ICC.txt"));
      assessment =
        "Krilla profile bytes are present; the source-specific ICC notice identifies CC0 profiles. Existing colour-profile attribution and full dedication/fallback text are retained.";
    } else if (reference.source === "crate-hayro-jpeg2000-0.3.5") {
      refs.push(await sourceEvidence(reference.source, "assets/README.md", "provenance"));
      assessment =
        "Actual JPEG2000 profile bytes are present. The source README separately identifies LCMS-created LAB and Compact-ICC-Profiles CGATS/ProPhoto as CC0; retain that statement and full CC0 text.";
      remaining.push(
        "LAB has a source-author provenance statement, not an independently reproduced LCMS generation recipe; no stronger authorship assertion is made.",
      );
    } else {
      assessment =
        "Actual CGATS profile bytes match the earlier source-matched CC0 evidence; retain its exact source/author provenance and dedication, not the surrounding crate licence alone.";
    }
  } else if (/hyphen(?:ation)?\//.test(member)) {
    if (/\/(?:de|pl|pt|it)\.pat$/.test(member)) {
      const bytes = await sourceFile(reference.source, member);
      const header = bytes.toString().match(/^(?:%[^\n]*(?:\n|$))+/)?.[0];

      if (
        !header ||
        !header.includes("Copyright") ||
        !/Permission is hereby granted|Redistribution and use in source and binary forms/.test(
          header,
        )
      )
        throw new Error(`Missing complete pattern permission: ${member}`);
      refs.push(
        await retain(
          Buffer.from(header),
          "permission-text",
          reference.source,
          `${member}#complete-leading-comment-block`,
        ),
      );
      rules.push(member.endsWith("pt.pat") ? "bsd" : "mit");
      assessment =
        "Exact patterns are present. Complete original leading copyright/permission/disclaimer was read and retained; Italian chooses the offered MIT alternative, not an assumed LPPL-only status.";
    } else {
      refs.push(cc0, await sourceEvidence(reference.source, "ATTRIBUTION.md", "provenance"));
      rules.push("cc0");
      assessment =
        "Moby/Grady Ward public-domain input and generated CC0 pattern claims are explicit in source attribution. Keep those source-specific statements rather than applying the app root licence to the dictionary.";
      remaining.push(
        "Independent verification of the public-domain source/conversion provenance remains bounded to the retained upstream assertion and hashes.",
      );
    }

    disposition = "conservative-notice-evidence";
  } else if (
    member.includes("numbers.postcard") ||
    /crate-(?:icu_|unicode-)/.test(reference.source)
  ) {
    refs.push(unicodeEvidence);
    rules.push("unicode");
    disposition = "conservative-notice-evidence";
    assessment =
      "Generated Unicode/ICU/CLDR material is evaluated separately from the code licence. Full Unicode-3.0 terms with ICU4C/ICU4J/IBM adaptation credit are retained conservatively; exact byte observations, where present, are recorded separately.";
    remaining.push(
      "Per-version input copyrights and transformation/linked-table provenance are not established for every generated candidate; see exact source/member entry, not a blanket package-clearance claim.",
    );
  } else if (reference.source.startsWith("crate-encoding_rs-")) {
    refs.push(
      await sourceEvidence(reference.source, "LICENSE-WHATWG"),
      await sourceEvidence(reference.source, "COPYRIGHT", "copyright-source"),
    );
    rules.push("bsd", "mit");
    disposition = "conservative-notice-evidence";
    assessment =
      "encoding_rs data.rs explicitly distinguishes MIT/Apache code from WHATWG indexes.json data under a BSD-3-style notice. Full WHATWG text and Mozilla copyright retained, including binary notice and no-endorsement requirements.";
  } else if (/\.(?:wgsl|glsl|vert|frag|css)$/.test(member)) {
    const pkg = closure.manifest.packages.find(
      (pkg) =>
        pkg.sourcePin === reference.source &&
        (!pkg.cratePath || pkg.cratePath === "." || member.startsWith(`${pkg.cratePath}/`)),
    );

    const legal =
      pkg?.files.filter((path) => /(?:^|\/)(?:LICENSE|LICENCE|COPYING)(?:[._-]|$)/i.test(path)) ??
      [];

    for (const path of legal)
      refs.push(await retain(closure.files.get(path)!, "permission-text", reference.source, path));

    if (!refs.length) {
      const canonical = references.find(
        (candidate) =>
          candidate.sha256 === reference.sha256 &&
          candidate.source.startsWith("git-storytold-egui-"),
      );

      if (canonical)
        refs.push(
          await sourceEvidence(canonical.source, "LICENSE-MIT"),
          await sourceEvidence(canonical.source, "LICENSE-APACHE"),
        );
    }

    if (!refs.length)
      remaining.push(
        "Establish exact upstream permission/attribution for this shader/CSS copy; a filename or surrounding project licence is insufficient.",
      );
    rules.push("retain-copied-source-code-notices");
    disposition = refs.length ? "conservative-notice-evidence" : "unresolved";
    assessment =
      "Shader/CSS source is an embedded runtime asset, not merely an unshipped build tool. Source-specific package notices are retained; exact byte matches are recorded where observed.";
  } else if (/spelling\/|thesaurus\.txt|\/i18n\/.*\.tsv$/.test(member)) {
    refs.push(
      await sourceEvidence(reference.source, "LICENSE-MIT"),
      await sourceEvidence(reference.source, "NOTICE", "copyright-source"),
    );
    rules.push("mit");
    disposition = "conservative-notice-evidence";
    assessment =
      "Source labels these word lists/translations as contributor-authored under repository terms. Preserve attribution; independent originality/third-party provenance is not inferred from a policy assertion.";
  } else {
    rules.push("source-content-and-emission-review-required");
    remaining.push(
      "Resolve this exact source/member's emitted content and any per-file/data-specific obligations before treating it as cleared.",
    );
  }

  if (reference.header)
    refs.push(
      await retain(
        Buffer.from(reference.header),
        "copyright-source",
        reference.source,
        `${member}#first-12000-bytes`,
      ),
    );
  materials.push({
    id: `source:${reference.id}`,
    category: "source-resource",
    artifacts,
    disposition,
    evidence: [...new Set(refs)],
    obligations: rules,
    assessment,
    remaining,
  });
}

const zodNotice = await retain(
  await readFile("tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/legal/zod/LICENSE"),
  "permission-text",
  "modified-build-verified-zod",
  "zod-4.5.4/LICENSE",
);

for (const asset of discovery.assets) {
  const refs = [...generatorRefs];

  if (asset.artifact === "deckcraft@0.14.1-hyori-host.1" && asset.path.endsWith("hyori-host.js")) {
    if (asset.sha256 !== "34579610572be4abd0696075e7d5dd3f63bb12f725f47ef54ef76533eab3f19d")
      throw new Error("Modified bridge module differs from compiled-source evidence");
    refs.push(zodNotice);
  }

  const app = asset.artifact.split("@")[0]!;
  refs.push(await sourceEvidence(`${app}-source`, "LICENSE-MIT"));

  if (asset.kind === "application-icon") {
    await sourceFile(`${app}-source`, `assets/app-icon/${app}.ico`);
    const tree = treeCache.get(`${app}-source`)!;

    const matched = [...tree].flatMap(([member, bytes]) =>
      member.endsWith(".ico") && sha256(bytes) === asset.sha256 ? [member] : [],
    );

    refs.push(
      await retain(
        Buffer.from(
          JSON.stringify({ asset: asset.path, sha256: asset.sha256, sourceMembers: matched }),
        ),
        "provenance",
        `${app}-source`,
        asset.path,
      ),
    );
    refs.push(
      await sourceEvidence(`${app}-source`, "NOTICE", "copyright-source"),
      await sourceEvidence(`${app}-source`, "docs/brand/LICENSE-brand.txt"),
    );
  }

  let disposition: Material["disposition"] = "conservative-notice-evidence";

  let assessment =
    "Each actual archive member is byte-pinned; adjacent generated/embedded material has separate dispositions.";

  if (asset.kind === "application-icon") {
    disposition = "protected-mark-gate";
    assessment =
      "Application icon is a separate distributed image. Upstream attribution and protected-mark context require review; root MIT/Apache alone is not trademark permission.";
  }

  if (asset.kind === "unclassified") disposition = "unresolved";
  materials.push({
    id: `asset:${asset.artifact}:${asset.path}`,
    category: "distributed-file",
    artifacts: [asset.artifact],
    disposition,
    evidence: refs,
    obligations: [
      asset.kind === "compiled-wasm"
        ? "compiled-input-and-embedded-material-notices"
        : "preserve-original-copyright-and-applicable-notices",
    ],
    assessment,
    remaining:
      asset.kind === "compiled-wasm"
        ? [
            "All compiled-code/data regions are not reverse-mapped to an independently attested linked input; full audit remains incomplete.",
          ]
        : [],
  });
}

for (const site of discovery.sites.filter((site) => site.resolved === null))
  materials.push({
    id: `include:${site.source}:${site.member}:${site.line}:${sha256(Buffer.from(site.expression))}`,
    category: "unresolved-include",
    artifacts: [],
    disposition: "unresolved",
    evidence: [],
    obligations: ["resolve-generated-or-external-build-input"],
    assessment: `Non-literal/generated include requires a source-to-output decision: ${site.expression.slice(0, 250)}`,
    remaining: [
      "Do not count missing literal matches as absence; reproduce or inspect the exact generated input under appropriate isolation if further resolution is needed.",
    ],
  });

const rustCatalog = await retain(
  await readFile(join(rustDirectory, "source.json")),
  "provenance",
  rust.url,
  "rust-source-component-manifest",
);

materials.push({
  id: "runtime:rust-1.99.1",
  category: "compiler-runtime",
  artifacts: discovery.binaries.map((binary) => binary.artifact),
  disposition: "conservative-notice-evidence",
  evidence: [rustCatalog, rustMit, rustApache, rustUnicode, builtins, libm, rustReuse],
  obligations: ["rust-stdlib", "compiler-builtins"],
  assessment:
    "All five inspected WASM producer sections report Rust 1.99.1 and wasm-bindgen 0.2.129, and observed /rustc/ source fingerprints equal the retained source commit. The pinned rust-src component supplies exact runtime source, licence and copyright evidence independently of Cargo app metadata.",
  remaining: [
    "Producer/source fingerprints are not signed build attestations; conservative source notices do not determine the exact set of linked target objects.",
  ],
});

for (const file of rust.files) {
  const specific = rust.evidence.find((evidence) => evidence.member === file.member);
  const refs = [rustMit, rustApache];

  if (file.member.includes("compiler-builtins")) refs.push(builtins, libm);

  if (file.member.includes("core/src/unicode")) refs.push(rustUnicode, rustReuse);

  if (specific) {
    const body = await readFile(join(rustDirectory, specific.path));

    if (sha256(body) !== specific.sha256) throw new Error("Rust source evidence changed");
    refs.push(
      await retain(
        body,
        /^(?:LICENSE|COPYING)/.test(file.member.split("/").at(-1)!)
          ? "permission-text"
          : "copyright-source",
        rust.url,
        file.member,
      ),
    );
  }

  materials.push({
    id: `rust-source:${file.member}`,
    category: "compiler-source",
    artifacts: discovery.binaries.map((binary) => binary.artifact),
    disposition: "conservative-notice-evidence",
    evidence: [...new Set(refs)],
    obligations: [file.member.includes("compiler-builtins") ? "compiler-builtins" : "rust-stdlib"],
    assessment:
      "Member belongs to the checksum-pinned compiler source component. Exact copyrights/permission clauses are retained; this conservative source set includes unlinked/test/platform-specific files and is not a claim that all are shipped in wasm32.",
    remaining: [
      "Target-linked object/function mapping is not independently attested; no platform-specific copyleft obligation is inferred merely from a broad Rust source inventory.",
    ],
  });
}

for (const binary of discovery.binaries) {
  materials.push({
    id: `wasm-unmapped:${binary.artifact}`,
    category: "unmapped-wasm",
    artifacts: [binary.artifact],
    disposition: "unresolved",
    evidence: [...generatorRefs, rustMit, rustApache, builtins, libm, rustUnicode],
    obligations: ["no-blanket-binary-or-legal-clearance"],
    assessment:
      "Actual data segments, fonts, source-byte observations and self-reported producers are parsed. Opaque code/transformed data and source-link provenance remain outside what this static inspection proves.",
    remaining: [
      "Establish complete generated-content/linked-source correspondence, including any non-signature, compressed or transformed payloads, before full notice-audit completion.",
    ],
  });
}

for (const tool of ["wasm-bindgen-0.2.129", "trunk-0.21.14", "binaryen-123", "walrus-0.27.2"]) {
  materials.push({
    id: `generator:${tool}`,
    category: "output-generator",
    artifacts: discovery.binaries.map((binary) => binary.artifact),
    disposition:
      tool.startsWith("wasm-bindgen") || tool.startsWith("trunk")
        ? "conservative-notice-evidence"
        : "not-shipped-tool",
    evidence: [...generatorRefs, ...generatorSources],
    obligations: ["generated-web-output"],
    assessment:
      "Review differentiates copied generated glue/templates from a transformation tool's own executable. No native tool binary occurs among the inspected browser distribution members; this is not a blanket output licensing opinion.",
    remaining: [
      "Official Trunk/Binaryen tool selection is not fully attested by the release binaries; retain the exact modified-build pins and observed WASM producers separately.",
    ],
  });
}

const eframeSource = "git-storytold-egui-6d518fc799681571963842f95b55a6b68431b15a";
const textAgentMember = "crates/eframe/src/web/text_agent.rs";
const textAgentBytes = await sourceFile(eframeSource, textAgentMember);
const inlineLiteral = textAgentBytes.toString().match(/inline_js\s*=\s*("(?:[^"\\]|\\.)*")/)?.[1];

if (!inlineLiteral) throw new Error("Shared eframe snippet source literal missing");

const inlineBytes = Buffer.from(z.string().parse(JSON.parse(inlineLiteral)));

const textAgentEvidence = await retain(
  textAgentBytes,
  "generator-source",
  eframeSource,
  textAgentMember,
);

const textAgentLicence = await sourceEvidence(eframeSource, "LICENSE-MIT");

for (const asset of discovery.assets)
  if (asset.path.startsWith("snippets/eframe-") && asset.path.endsWith("/inline0.js")) {
    if (asset.sha256 !== sha256(inlineBytes))
      throw new Error("Shared eframe inline JS is not the reviewed source literal");

    const material = materials.find(
      (material) => material.id === `asset:${asset.artifact}:${asset.path}`,
    )!;

    material.evidence.push(textAgentEvidence, textAgentLicence);
    material.assessment =
      "Exact shared eframe inline_js literal decoded from the pinned text_agent.rs matches this file byte-for-byte, including its actual line endings. Upstream egui/eframe MIT copyright and permission are retained separately from app and tool licences.";
  }

const cookedMaterials = [...new Map(materials.map((material) => [material.id, material])).values()];

const scopeDiscovery = {
  ...discovery,
  references: references.map(({ header: _header, ...reference }) => reference),
  assets: discovery.assets.map(({ inlineText: _text, ...asset }) => asset),
  binaries: discovery.binaries.map(({ segments, ...binary }) => ({
    ...binary,
    segments: [],
    segmentInventorySha256: sha256(Buffer.from(JSON.stringify(segments))),
    segmentCount: segments.length,
  })),
};

const discoveryBytes = Buffer.from(`${JSON.stringify(scopeDiscovery, null, 2)}\n`);

await writeFile(join(output, "discovery.json"), discoveryBytes, { flag: "wx" });

await writeFile(
  join(output, "network-observations.json"),
  JSON.stringify(
    {
      failures: networkFailures,
      meaning:
        "Missing optional probe paths are not automatically legal blockers; required evidence fails generation. Source provenance/rights gaps are explicit material dispositions.",
    },
    null,
    2,
  ),
  { flag: "wx" },
);

const audit = auditSchema.parse({
  schemaVersion: 1,
  kind: "bounded-content-review-not-legal-opinion",
  deployable: false,
  fullNoticeAuditComplete: false,
  compilerGeneratedNoticeAuditComplete: false,
  protectedMarksCleared: false,
  legalOpinion: false,
  scope: {
    discoverySha256: sha256(discoveryBytes),
    discoveredItemIds: cookedMaterials.map((material) => material.id),
    rustSourceArchive: {
      id: "rust-src-1.99.1",
      url: rust.url,
      sha256: rust.sha256,
      bytes: rust.bytes,
    },
  },
  evidence,
  materials: cookedMaterials,
  reviewedPolicies: policies,
  unresolved: [
    {
      id: "rights-data-provenance",
      description:
        "Adobe-derived metric/encoding source permission, per-version generated-data provenance and independently verified dictionary/translation provenance are not all established.",
      materials: cookedMaterials.flatMap((material) =>
        material.disposition === "unresolved" || material.remaining.length ? [material.id] : [],
      ),
    },
    {
      id: "protected-marks",
      description: "Brand gate remains owned by the UI/brand work; no marks changed or cleared.",
      materials: cookedMaterials.flatMap((material) =>
        material.disposition === "protected-mark-gate" ? [material.id] : [],
      ),
    },
  ],
});

const auditBytes = Buffer.from(`${JSON.stringify(audit, null, 2)}\n`);

await writeFile(join(output, "manifest.json"), auditBytes, { flag: "wx" });

await writeFile(
  join(output, "index.json"),
  `${JSON.stringify({ schemaVersion: 1, manifest: { path: "manifest.json", sha256: sha256(auditBytes) }, discovery: { path: "discovery.json", sha256: sha256(discoveryBytes) }, deployable: false }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(
  JSON.stringify(
    {
      materials: cookedMaterials.length,
      evidence: evidence.length,
      dispositions: Object.fromEntries(
        [
          "notice-evidence-reviewed",
          "conservative-notice-evidence",
          "unresolved",
          "protected-mark-gate",
          "not-shipped-tool",
        ].map((status) => [
          status,
          cookedMaterials.filter((material) => material.disposition === status).length,
        ]),
      ),
      output,
    },
    null,
    2,
  ),
);
