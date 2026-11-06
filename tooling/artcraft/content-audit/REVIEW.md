# Bounded content and generated-runtime notice review — 2026-11-05

This is **technical redistribution evidence, not a legal opinion, deployment approval, or assertion of complete binary reverse engineering**. `deployable`, `fullNoticeAuditComplete`, `compilerGeneratedNoticeAuditComplete` and protected-mark clearance remain false. Earlier legal bytes, official pins, and the built Deck WASM are unchanged.

## Later deployment-adoption checkpoint

The expressly authorized finite adoption slice now carries the positive AFM/AGL/PDFium permission/copyright/correspondence evidence into acquired notices (`notice-adoption-v1`) and the independently verified official-three runtime bundle (`runtime-official3-v1.json`). Current mapping/font behavior and all original vendor/notice bytes remain unchanged. The frozen audit/full-clearance flags remain false as historical confidence records, not a requirement to prove every optimized byte/unique historical toolchain before using supported express distribution permission and notices. The separately scoped runtime manifest enables only verified static Word/Grid/Pdf composition, not legal clearance/product acceptance. Modified Deck remains excluded until Opus's mark/version patch and coordinated build. See the current runtime handoff in `docs/artcraft-integration.md`; all four remain launch requirements.

## Actual inputs and reproducible coverage

- Every non-directory member of the four official pinned ZIPs was read: WordCraft 26, GridCraft 13, DeckCraft 12, PdfCraft 11. The modified Deck distribution contributes six files. All **68 distributed files** have a disposition.
- WASM data sections were parsed statically, including split/overlapping segments and zero-fill; no vendor code was instantiated or built. **54 sfnt table instances** were structurally identified. These are instances, not 54 distinct typeface families; Type1 fonts are separate resources.
- The independent artifact verifier rechecks all 68 files and **481 exact embedded source-byte regions**, not just dependency metadata or filenames. A negative source-byte search does not establish absence after optimization, compression, subsetting or other transformation.
- All five WASM producer sections report rustc `1.99.1 (58cf8f9c3 2026-10-13)`, wasm-bindgen `0.2.129 (165586f85)` and walrus `0.27.2`. Observed `/rustc/` source fingerprints match `58cf8f9c35b355199727627d07ae34a4e2846d67`. These are observed, self-reported fingerprints, not signed link attestations.
- The exact Rust source component is `rust-src-1.99.1.tar.gz`, SHA-256 `b0d6d3a7e46a97adfe6488f8b60c04c019566b8363eeb6ffb32c6cf63609071d`, from the installed compiler's public component manifest. Its **3,608 library source members** have hash/copyright/permission records; **127 full original licence/source members** were retained, including per-file math notices. A source candidate is not asserted to be linked merely because it appears in that source component.
- WordCraft's external translations are pinned at `craft-i18n@9205108cfdced5177706264038848b68b2422d2b`: 61 relevant common/app catalogs were examined, 54 were directly byte-observed. MIT/Apache texts and translator attribution are retained. The other seven are not asserted absent or shipped.

`index.json` pins the audit and discovery manifests. `manifest.json` gives every discovered item one disposition, evidence references, obligations, and remaining actions. It currently contains **5,568 dispositions**: 350 reviewed notice-evidence decisions, 3,981 conservative source/notice decisions, 1,228 unresolved entries, seven protected-mark/context entries, and two unshipped transformation-tool entries. Many unresolved entries are _source candidates or non-literal includes_, not proven runtime material or independently established legal violations. The exact IDs, source members and reasons are finite and machine-checkable.

## Content decisions grounded in actual permission text

### Fonts, icons and other embedded assets

- Shared egui material is five faces, including the small `egui-icons.ttf` subset separately from its parent `emoji-icon-font.ttf`. Both icon faces use the exact John Slegers 2014 MIT notice; the depicted logos are not thereby granted trademark clearance.
- Ubuntu Light is UFL 1.0, not MIT. Its original/modified-name requirements, copyright/licence retention and no-trademark-grant clause were reviewed.
- Hack includes Source Foundry MIT **and** Bitstream Vera conditions, plus the DejaVu public-domain statement. Reserved names, copyright/trademark notice retention and no standalone font sale are not omitted.
- App fonts, Noto Emoji, Source Sans/Serif, Inter, JetBrains Mono and Dancing Script retain their actual OFL/copyright records. Reserved-name and no-standalone-sale conditions are distinguished from the software bundle/document-output rules.
- The otherwise-unmatched Georgian font is resolved to `craft-fonts@b076417b5880bd4154bd22f00695b1d28c6bea83`, its pinned font manifest, the actual downloaded font's matching sfnt-table extent, and its OFL text. Source-file padding is not confused with table-extent identity.
- Actual PdfCraft Lucide SVG copies require the complete ISC notice **and**, for the listed Feather-derived work, Cole Bemis MIT notice; an ISC-only or app-root-MIT label is insufficient.
- Fourteen Foxit/PDFium Type1 substitutes and the compressed Adobe CMap asset retain their full asset-specific BSD-3 copyright, conditions and disclaimers, not just the product NOTICE's summary.
- Actual ICC material includes the previously matched CGATS profile, Krilla profiles, and JPEG2000 LAB/ProPhoto profiles. Exact source-specific ICC notices, full CC0 and the JPEG2000 README's distinct provenance statements are retained. The LAB author statement is not an independently reproduced LCMS generation recipe.
- Moby/public-domain and generated CC0 dictionary/pattern assertions are separate from app MIT/Apache. Polish, German and Italian preserve their complete original MIT-option headers; Portuguese preserves its actual BSD-3 header. An MIT-only header extractor initially rejected the BSD case and was not weakened; the new content collector preserves the proper original block instead.
- Contributor-authored spelling/thesaurus/translation assertions are recorded as upstream assertions, not independent originality guarantees.

### Generated data versus code licences

- `encoding_rs/src/data.rs` explicitly distinguishes MIT/Apache code from WHATWG index data. The complete WHATWG copyright/BSD-style binary-notice/no-endorsement terms and Mozilla copyright are retained.
- Unicode/ICU/CLDR data are not cleared by adjacent MIT/Apache code. Unicode v3 permission/copyright and the ICU4C/ICU4J/IBM adaptation credit are retained. Exact per-version upstream data/transformation provenance is not established for every generated source candidate.
- **PdfCraft Adobe-derived metrics and encodings remain unresolved.** The source calls them Adobe Core14/ISO-derived data, then assigns project MIT/Apache. That declaration and the project's asset policy do not themselves establish an upstream rights basis. The record does not conclude that numerical facts are copyrightable or that redistribution is unlawful; resolution requires documented provenance and a supported redistribution basis, or an appropriate replacement, rather than silent licence inference.

### Compiler/runtime and web generator output

- Rust's general **MIT OR Apache-2.0** does not cover every exception by itself. The exact Rust `REUSE.toml` assigns the core Unicode data to **Unicode-3.0**, with its own copyright.
- **Compiler-builtins declares MIT AND Apache-2.0 WITH LLVM-exception.** The object-embedding exception's stated waiver of Apache sections 4(a), 4(b), 4(d) does not waive MIT obligations. The complete conjunction, exception, pre-2019 compiler-rt credit statement and libm/musl/CORE-MATH material are retained.
- Per-file Sun/FreeBSD/math permission blocks are not replaced by a generic Rust licence. Two complete Sun notices in `rem_pio2_large.rs` and `erf.rs` occur **after attributes/imports**; these were inspected and explicitly included, rather than silently dropped by a leading-comment-only extractor.
- wasm-bindgen's copied JS glue and dependency snippets, Trunk's injected loader template, and the modified host bundle's Zod MIT are treated as emitted/copied content. Generator source and exact full licence bodies are retained. All five identical 280-byte eframe snippets match the decoded `inline_js` literal in pinned `crates/eframe/src/web/text_agent.rs` byte-for-byte, including actual line endings; upstream egui/eframe MIT copyright/permission is referenced separately from the app and tool licences.
- Binaryen and Walrus are distinguished as transformation tools; no native executable is among the audited browser members. Their presence as build tools does not by itself mean all their dependency licences apply to output. The reviewed recipe requests `-Oz`, not Asyncify/instrumentation. Official Trunk/Binaryen tool correspondence is not independently attested; the modified Deck build's separate pins remain the exact own-build evidence.

## Notice delivery and remaining blockers

`bun scripts/artcraft/content-notices.ts /absolute/new-output` generates a **130-file technical notice supplement**: 71 byte-preserved permission/condition texts, 56 runtime source-notice files, one human-readable observed-font copyright file, an explanatory README and a hash manifest. All reviewed per-file compiler notices are included; the generated manifest has no omitted source-prefix entries. This does **not** mean all runtime/data rights or source-linkage questions are resolved.

**Later local-integration checkpoint (2026-11-05):** the exact 130 generated files are now frozen under `tooling/artcraft/notice-supplement/` and verified into both official acquisition and the retained modified-Deck acquisition path. Twelve additional whole-file attribution/copyright/NOTICE witnesses and five index/coverage/correspondence records bring each delivery to 147 files. `legal/NOTICE-INDEX.md` explains the preserved historical wording in the original generated snapshot. Both actual local assemblies passed independent notice verification; runtime delivery/publication remains unimplemented and unauthorized. See `docs/artcraft-integration.md` for commands and evidence. No original legal/vendor/patch/build bytes or approval flags changed.

Concrete open work:

1. Decide adoption of the later positive data evidence and mapping semantic policy. The bounded `font-data-feasibility/FEASIBILITY.md` follow-up now retains explicit AFM-specific permission and a full 3,584-slot reproduction witness, exact BSD-permitted AGL correspondence for all 231 glyph-name pairs, and BSD-noticed PDFium mappings with their finite compatibility differences. Do not require a width replacement simply because permission evidence was formerly missing: a supported positive existing-data basis is now documented. That is not legal clearance or notice-package adoption. The original authors' historical inputs remain distinguished from this reproducible basis, and the original audit/discovery snapshots and their unresolved flags are preserved.
2. Resolve applicable generated-data/source transformation provenance and linked-content correspondence; opaque or transformed WASM content remains explicitly unresolved. Do not infer absence from a negative byte search.
3. Complete any remaining per-version data and independently reproduced dictionary/profile/catalog provenance actually required by the selected distribution. The finite source/include candidate list is not itself a claim that every candidate ships or blocks deployment.
4. Verify end-user notice delivery; retained files alone are not proof that a deployed distribution includes them.
5. Preserve the separate protected-mark/UI gate. No mark, logo, favicon or UI was replaced here.
6. Preserve real backend/SDK/WASM lifecycle and format-fidelity gates owned outside this content slice.

No unchanged Deck WASM rebuild was performed. Downloaded source remained data; each new archive was independently staged, hash/path validated and read by authored tooling outside its tree. No host vendor builds, subagents, commits or pushes were used.
