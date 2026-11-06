# Standard-font source-data feasibility — bounded outcome

2026-11-05. **Technical evidence, not legal advice/clearance. No replacement selected or implemented.** Official pins, vendor/patch/build bytes, the frozen audit and 147-file acquisition composition are unchanged. All clearance/deployability flags remain false. No vendor binary/library, Rust/C++ build, font renderer, Docker or browser was run.

## Subsequent notice adoption

The authorized deployment-adoption slice now incorporates the positive AFM/AGL/PDFium evidence in exact acquired notices under `tooling/artcraft/notice-adoption-v1/`, preserves current mapping behavior, and emits a separately scoped official-three static bundle. See `tooling/artcraft/runtime-official3-v1.json` and the current handoff section of `docs/artcraft-integration.md`. The original feasibility/audit flags remain historical confidence records; no product bytes or numeric tables were replaced and no legal clearance is claimed. References below to a future adoption describe the earlier investigation checkpoint, not an outstanding blanket block after that adoption. Deck's modified-version marks/build/lifecycle remain separately blocking all-four completion.

## Decision-ready conclusion

**Accept the newly found positive existing-data basis before requiring a width replacement.** The fourteen Adobe core-font AFMs have an explicit, asset-specific permission paragraph and reproduce **all 3,584 existing width slots**, under the explicitly recorded encoding/undefined-code policy. The current **231 glyph-name mappings** also match values in the independently BSD-permitted Adobe Glyph List (AGL). These are positive permission/correspondence witnesses, not root-SPDX inference. The fact that the original authors' exact historical generation inputs are not established does not justify ignoring this supported reproduction basis or automatically requiring replacement fonts.

This is not approval to distribute: the new evidence has not been adopted into the frozen legal/acquisition package; its notices/conditions and the remaining mapping policy need an explicit adoption decision. The current flags and historical audit rows remain false/unresolved snapshots rather than being silently rewritten.

**Foxit widths are completely obtainable for this workload, but are not a numerically equivalent substitute.** All 3,210 glyph widths in the fourteen retained programs decode under the bounded static prefix method. All 14 × 256 comparison slots are accounted for, including explicitly identified undefined-code zero policy. **3,568 match; 16 differ; zero remain unknown.** Substituting these values without accounting for layout/rendering behavior would introduce a regression, not merely fix notice provenance.

**Permissively noticed mapping implementations exist.** PDFium has file-level BSD notices for WinAnsi/MacRoman/Standard implementations; Standard matches all 256 current entries. WinAnsi/MacRoman differences are explicit below. No new production CFF parser is needed: the already locked APIs return the desired width.

## Exact evidence and obligations

[The pinned input index](index.json) retains 58 complete source/data/permission witnesses; its SHA-256 is `17a0e042f8e1041d6ae5cc208134d71b6e65559418a8720bf23f898183fd10b0`. [result.json](result.json) is reproducible offline and contains every numeric difference and its literal CFF proof. Existing Foxit programs are reused from the unchanged, checksum-validated PdfCraft source archive; no replacement font/image asset was sourced.

- **AFM-specific grant:** [complete companion readme](39.txt), immutable Matplotlib mirror revision `f9db3d8c59a8453601ad81514f9c295d6ec050e1`, SHA-256 `311bfca694884d86006fb96de443b0f4359635921b95fc6c161bb94d013b7292`. It expressly permits use, copying and distribution of the file and its fourteen accompanying AFMs, for any purpose and without charge, **with or without modification**, subject to copyright retention, accompanying the AFMs with this file, prominently noting modifications, and leaving the permission paragraph unchanged. All fourteen complete AFMs, their individual copyright/trademark statements and this whole readme are retained, not summaries. A conservative future adoption should preserve those bytes and identify the AFM-to-Rust conversion; the app's MIT/Apache label is not substituted for these conditions.
- **PDFium mappings:** [complete cpdf_fontencoding.cpp](35.txt), revision `a84323421e94f484faca52dd9d027934eba42ab8`, SHA-256 `297fa9008bd56a9d98cc80f1a5b50efd4d21173580bb61c2116a199b7ec167e9`. Its own header states Copyright 2016 The PDFium Authors and directs the reader to the BSD-style licence. [Complete LICENSE](33.txt) and AUTHORS are retained. This is a source-specific notice connection, not an assumption that every third-party asset in PDFium inherits its root licence. Preserve copyright, conditions, disclaimer and no-endorsement requirements.
- **AGL:** [complete glyphlist.txt](41.txt), immutable Adobe revision `4036a9ca80a62f64f9de4f7321a9a045ad0ecfd6`, SHA-256 `a3b2f61ced9f3644cc0d4ecde5c59df34ca286c689d9484a43a710a81c466789`. Its header supplies the full Adobe 2002–2019 BSD-style permission, conditions, no-endorsement clause and disclaimer. Every current `NAMES` pair matches; this is not a grant for unrelated Adobe AFM/specification data.
- **Foxit programs:** the existing fourteen `.pfb`-named inputs are actually CFF1 in the inspected bytes; retain their exact [PDFium/Foxit-specific permission](6.txt). They are analysis inputs, never enabled as new assets.
- **Apple semantic context:** [ROMAN.TXT snapshot](apple-roman/ROMAN.txt), SHA-256 `18e571645be895e9553ed5c842ea8f65f9c5d3c9ccb43e66e0c33a132ed0d721`, documents the 1997 Omega canonical-decomposition update and 1998 euro update. This is an explicitly mutable publisher snapshot with retained bytes, not an immutable version claim. Its own header is **not** an express redistribution grant; it is context, not the proposed permissive mapping source or a silently inferred licence.

Public research sent only public repository/file identifiers. Every raw fetch used a fresh staging directory and bounds. API HEAD responses are labelled observed snapshots; source files subsequently use the resolved immutable revisions. All further checks use retained inputs and need no network. No upstream scripts were executed.

## Existing CFF APIs — no new production parser

Two actual dependency boundaries were checked, not just a newer API in an unrelated crate:

1. **Hayro's current wrapper:** `vendor/hayro-interpret` uses `skrifa 0.47.0` / `read-fonts 0.44.0`. [CffFontRef source](21.txt) exposes `evaluate_charstring(...) -> Result<Option<Fixed>, Error>` and `draw(...) -> Result<Option<f32>, Error>`; the latter applies font-matrix/size transformation to the returned width. `Subfont` supplies default/nominal widths. [CffFontBlob](0.txt) already obtains subfonts and calls `draw`, but discards its result in `outline_glyph`. [StandardFontBlob::advance_width](1.txt) returns `None` for CFF despite this available underlying result. Its standard-font `get_width` still uses the parallel generated AFM-style tables; calling it is not independent font-program measurement.
2. **The actual `pdfcraft-fonts` crate:** [its retained manifest](font-helper-parser/4.txt) directly uses `skrifa = "0.44"`, not Hayro's 0.47. [The checked source](font-helper-parser/2.txt) publicly re-exports `read_fonts` as `raw`; its locked `read-fonts 0.41.0` also has the [width-returning CFF draw/evaluation API](font-helper-parser/0.txt). [The separate pinned witness index](font-helper-parser/index.json) is SHA-256 `200d3f174f5a75b3c086e27a3683a00f14d6b048bf214b94fb9664948681aa00`. A future font-helper-side measurement operation therefore need not add a new parser dependency or assume access to Hayro's private wrapper types.

No hypothetical adapter was compiled or executed. A future adapter should reuse these owned APIs, preserve `Result`/optional-width handling and normalize units explicitly. This research's TypeScript decoder is **not** a proposed production parser.

## Numeric findings and their limits

The research decoder validates CFF1 INDEX/DICT/charset bounds, SID strings, single-face/non-CID input and the default 0.001 FontMatrix. It decodes only the literal prefix needed to establish width, including bounded fixed-literal subroutine references; it stops before outlines and does not evaluate general arithmetic/branches, render a font, or invoke vendor code. Stack, recursion, index counts, byte bounds and work are bounded. Unsupported prefixes would be unknown, not zero; none was unknown for these pinned inputs. Each differing glyph includes its source byte offset, leading bytes and literal/nominal-width proof. This is not a general CFF validator or an independent running-engine comparison.

For text faces the comparison uses BSD-noticed PDFium WinAnsi glyph names with the **frozen current undefined-code mask as an explicitly labelled oracle**, not a claim of independently established historical encoding inputs. Symbol/Dingbats use the permissively accompanied AFM's own code/name assignments. Undefined codes yield zero by comparison policy; that is not a claimed glyph width extracted from a font. The 3,584-slot AFM equality is conditional on this disclosed policy.

The 16 CFF differences occur in Helvetica-family faces and three Times faces. For example, Helvetica `Euro` is **667** in the retained font versus **556** in the current AFM-derived table; Helvetica-Bold `at` is **1072** versus **975**. The result contains the complete difference list. Courier, Times-Italic, Symbol and ZapfDingbats match every compared slot.

Coverage of these encoded slots is not coverage of every possible glyph-name fallback. The AFMs contain 315 glyph metrics per text face. The Foxit Helvetica/Times faces omit **86 AFM glyph names each**; Courier faces omit **84 each**. Symbol/Dingbats omit none. Any proposal to replace Hayro's broader name-based `get_width` must handle those missing names too. No negative byte-search absence claim is used here: these are exact parsed charset-name set differences.

### Mapping compatibility, not just licence labels

- **Direct PDFium numeric tables:** WinAnsi matches **250/256**, MacRoman **239/256**, Standard **256/256**. All differing values are retained; blindly copying these tables would change behavior.
- **PDFium glyph-name tables joined to the explicitly permitted AGL:** WinAnsi still matches **250/256**, MacRoman improves to **254/256**, Standard remains **256/256**. This comparison emits no product replacement table.
- **Six WinAnsi cases:** codes `0x7F`, `0x81`, `0x8D`, `0x8F`, `0x90`, `0x9D` are zero/undefined in the current implementation but bullet aliases in PDFium. Preserve or change that policy only by explicit decision; do not silently broaden encodability or alter extraction/redaction matching.
- **Two remaining joined MacRoman cases:** `0xBD` is current U+03A9 versus AGL `Omega` U+2126; `0xDB` is current euro U+20AC versus the PDFium glyph name `currency` U+00A4. The Apple header records exactly these historical updates. A modern Apple mapping matches **255/256** current entries; the remaining `0xCA` is U+00A0 there versus ordinary space U+0020 in the current PDF-specific implementation. That snapshot is explanatory context, not an adopted permissively licensed input.
- **Space/hyphen behavior:** current WinAnsi `0xA0`/`0xAD` and MacRoman `0xCA` must continue the documented PDF extraction/writing semantics. A platform codepage is not a drop-in substitute.

## Minimal technical paths, without selecting one

**Supported existing-data path: zero product-source replacements are required by the earlier missing-AFM-permission concern alone.** Retain/adopt the explicit AFM/AGL/PDFium evidence and its notice conditions through an authorized provenance/notice update. Confirm/document the six WinAnsi and two joined MacRoman compatibility cases and PDF-specific space/hyphen policy. Keep current numeric behavior if that is the selected policy. Historical-generation provenance is distinguished from this new positive reproduction basis. Nothing in this slice adopts those conditions into the frozen acquisition bundle or changes clearance flags.

If a separately authorized decision nevertheless requires a source replacement:

- **Mapping-only boundary:** `crates/fonts/src/encodings.rs` is the minimal data owner for `WIN_ANSI`, `MAC_ROMAN`, `STANDARD` and `NAMES`. Keep its array sizes/types and sorted glyph-name lookup contract. A BSD/AGL-based derivation plus explicit compatibility choices can be assessed here without changing consumers' APIs. It has not been implemented. Standard and all 231 `NAMES` values already have exact positive correspondences, so a semantic change is not technically necessary for them.
- **Font-derived width boundary:** `crates/fonts/src/std14_metrics.rs` owns the 14 × 256 matrix/order/base names; `std14.rs` interprets it. Replacing only the matrix with Foxit values changes 16 slots. Canonical unembedded Core14 output and the renderer may still assume AFM widths, so this is **not** a safe two-file substitution. Either preserve canonical metrics on the positive AFM basis or explicitly design actual-font embedding/width metadata/rendering consistency, which is a larger path, not selected here. A runtime Hayro adapter would minimally involve `font/blob.rs` and `font/standard_font.rs`; a font-helper-owned operation can instead reuse its own existing raw CFF API without exposing vendor-private types. No new parser is justified by current API availability.
- **Do not move the same unresolved data:** copying Hayro's parallel generated tables, relabelling root MIT/Apache, or disabling capabilities does not constitute a replacement/provenance solution.

Direct consumers remain `crates/fonts/src/std14.rs` (advances/string measurement/base names), `crates/fonts/src/lib.rs` (writing/encodability/wrapping), and `crates/fonts/src/pdf.rs` (widths, extraction, named/default encodings and glyph-name/Differences lookup). [consumers.json](consumers.json) retains 55 exact source-reference members and lines from the pinned archive, including appearance generation in `annot`, `forms`, `edit`, `create`, OCR/XFA text, redaction, engine extraction and renderer inspection. It is a **reference witness list**, not an exhaustive Rust alias/re-export/feature call graph; unrelated font APIs and test references are labelled and do not imply every listed file needs editing. No UI review/change was performed.

Required acceptance for any chosen change: all 14 × 256 slots/undefined codes; every one of the 16 measured width deltas; broader AFM-name fallback coverage; all 256 mapping entries; six WinAnsi bullet/undefined cases; MacRoman Omega/euro and `0xCA`; WinAnsi space/hyphen aliases; glyph-name variants/composites/Differences; Symbol/Dingbats; actual rendered advances versus appearance wrapping/placement; annotations/forms/flattening; text creation/edit/rewriting; extraction/search/selection/redaction; OCR/XFA generated text; save/reopen and embedded/unembedded font consistency. Do not silently drop a product capability.

## Reproduce offline

```sh
bun scripts/artcraft/content-font-feasibility.ts
bun test scripts/artcraft/content-font-feasibility.test.ts
bun x --no-install tsc --project scripts/artcraft/tsconfig.content.json --noEmit
bun run lint:anti-slop
```

The pinned 58-file index, separate five-file parser index and Apple snapshot hash are checked before analysis. Tests reject tampering/missing witnesses, malformed/bounded CFF input, cyclic/unsupported prefixes and unsupported source-table tokens; they enforce the exact numeric results, source-specific permission evidence and still-false gates. Existing acquisition and audit checks remain separate and unchanged.
