# ArtCraft browser integration findings

Updated 2026-11-05. All four editors remain approved v1 requirements. Actual SDK/backend/browser acceptance is distinct from static packaging; an iframe launcher alone is not cloud document editing.

## Current all-four static handoff — final corrected Deck .2

The existing final restricted build has now been collected and verified **without restarting it or touching the LAN deployment**. The frozen Opus marks/functional patch, corrected v2 bridge and actual compiled outputs are composed with the unchanged official Word/Grid/Pdf assets. All four static editor entries now exist; this is not a claim that actual all-four browser save acceptance or product launch has passed.

- **Current bundle root:** `tooling/artcraft/.generated/runtime-all4-v2/`.
- **Manifest:** `runtime-bundle-manifest.json`, **1,217,401 bytes**, SHA-256 **`bb6d2eb3f4e81976429c4e0c65de57452898398dd962af7e81083478daa28ea0`**.
- **3,964 individually hashed payload/notice/source files**, **212,379,781 bytes**, plus the manifest. Modes remain files **0444**, directories **0555**; parent additionally mounts read-only under `/artcraft`.
- **Single backend identity authority:** [`tooling/artcraft/runtime-deckcraft-v2.json`](../tooling/artcraft/runtime-deckcraft-v2.json); no parallel hand-maintained hash catalogue is needed.
- **Compact bundle receipt:** [`tooling/artcraft/runtime-all4-v2.json`](../tooling/artcraft/runtime-all4-v2.json).
- **Complete modified-source summary:** [`builds/deckcraft-host-v2/run-2026-11-05/source-summary.json`](../tooling/artcraft/builds/deckcraft-host-v2/run-2026-11-05/source-summary.json), with all 23 final-vs-tagged source changes, five frozen author-source witnesses, preserved original legal bytes, reused Hyori image identities, exact source replay, unchanged lock/dependency graph and unchanged seven embedded-font identities.

The four authoritative iframe URLs are:

```text
/artcraft/wordcraft/0.14.0/index.html?host=parent
/artcraft/gridcraft/0.15.0/index.html?host=parent
/artcraft/pdfcraft/0.17.0/index.html?host=parent
/artcraft/deckcraft/0.14.1-hyori-host.2/index.html?host=parent
```

Deck's new manifest discriminant is `bridge: "hyori-correlated-host-v1"` and exact `version: "0.14.1-hyori-host.2"`. Its source archive SHA-256 is **`6e03f2e9532c0102ec01d8be8bba556a0191ee11d5ca64412a5b48457afddfb7`**, exact retained build-manifest SHA-256 **`eb9efd3888731d7b770a5dbc7643d8ecea00f74e0a3e7410d0ec5c5b999531c2`**, and canonical payload SHA-256 **`69404214dfe470e545cf997af4b224b043e389e2e58032bc643e8f46ca56d3d7`**. The payload hash uses ASCII-path-sorted `{path,bytes,sha256}` records, fixed key order, UTF-8 `JSON.stringify`, no indentation/newline, and includes exactly six editor payload members—not shared legal files/root manifest. The full receipt SHA-256 is **`1a651c60bd31aa8fea0f059aca0f8e611556f9a87db4bd0c0fa84ec7481fe62d`**.

The compiled WASM is **32,283,455 bytes**, SHA-256 **`81ecb8a33cf3a8fc7f2dc559b334728ae52b2da2f3ef452ced11ae244477ef98`**. Its copied host snippet is the frozen corrected **187,418-byte** v2 JS, SHA-256 **`cbaf952ff39f19859ee90cf04d7839eb4a7dc6bf61fbfc650b718c25e01be0c6`**; this is **not** the historical `.1` bridge. The actual output lives at `snippets/deckcraft-web-78a7450ef22232a7/hyori-host.js`, preserving wasm-bindgen's relative imports.

### Actual build/collection evidence and limits

All six completed driver commands recorded exit **0**: rustc, Cargo release/offline/locked (**384,764 ms**), metadata, normal/host trees and Trunk release/offline/locked (**590,954 ms**). They used the exact previously pinned Rust image/tools, no network, UID 1000, read-only root/input/tools, dropped capabilities/no-new-privileges and bounded CPU/memory/PIDs. No new build was started during collection. The original outer attachment/session ended without `container-result.json`; **container exit status remains null/unobserved**, not fabricated as zero. Complete dist, command-result files and exact input/output hashes establish the successfully completed compilation/package operations. The owned build container is no longer present. No LAN project/service/configuration was accessed or changed.

The earlier stopped `deckcraft-host2-attempt-2` remains **unshipped diagnostic only**, with intentional cancellation status 137; it is not the final build. Historical `.1` evidence and the official-three bundle are unchanged. The final freeze fixes PPTX ordinary Save to explicit native `.deckcraft` copy and permits authorized explicit read-only Save As while still refusing read-only replacement. Repeated ordinary Save from the original PPTX creates another explicit copy; no silent source overwrite is claimed. Opus owns product/mark presentation; the retained built-in theme identifier and copyright/source attribution are not wholesale removed. Unused original source-brand assets are not emitted as runtime payloads, and a negative byte search is not used as a legal clearance proof.

Original notices and complete changed source members accompany `.2` under `legal/deckcraft-host-v2/`, including `MODIFICATIONS.md`, exact build/receipt/authority/source-summary records and the original matching-source references. The static manifest has `deployable: true` only for verified static redistribution composition; `legalOpinion`, full-audit, `productIntegrationVerified` and `allFourLaunchReady` remain false. There are no remaining substantive static-distribution blockers recorded for the four included entries. Actual browser/native-format/backend/SDK/copy/conflict/revocation/fidelity acceptance remains parent-owned and must not be inferred from the earlier synthetic or `.1` fixtures.

```sh
bun scripts/artcraft/content-runtime.ts check tooling/artcraft/.generated/runtime-all4-v2 \
  bb6d2eb3f4e81976429c4e0c65de57452898398dd962af7e81083478daa28ea0
# Reassemble only from existing verified local acquisition/build evidence, no build/network:
bun scripts/artcraft/content-runtime.ts assemble /absolute/new-all4-output \
  tooling/artcraft/.generated/notice-adopted-official-1 \
  tooling/artcraft/.generated/deckcraft-host2-final-evidence-1
```

The final suite passed **150 tests / 15,568 assertions**, including actual `.2` all-four composition, payload/source/notices/readonly checks and tamper rejection. Both scoped TypeScript checks and root anti-slop passed. Parent/backend owners received the exact authority and bundle path/hash before LAN integration. This slice did not restart a build, start a service, modify private configuration, commit, push or operate `hyori-lan-t3-ce2b2e51`.

## Historical official-three handoff — preserved unchanged

The latest finite adoption slice produces a **verified read-only static bundle for unchanged official WordCraft 0.14.0, GridCraft 0.15.0 and PdfCraft 0.17.0**. All four editors remain launch requirements; this three-app asset checkpoint does not substitute for working DeckCraft. No cosmetic UI, root CI, backend/SDK, live Caddy/Docker or LAN-project change is made by this owner.

- Bundle directory: `tooling/artcraft/.generated/runtime-official3-v1/`.
- Exact manifest: `runtime-bundle-manifest.json`, **829,146 bytes**, SHA-256 **`1bfd3449257f4bd8cf7b6c124817754dda5406e707b26a36a76dff1db318e8fc`**.
- **2,764 separately hashed asset/notice files**, **160,302,881 bytes**, excluding the manifest. Files are **0444**, directories **0555**; parent must additionally mount read-only.
- Durable handoff receipt: [`tooling/artcraft/runtime-official3-v1.json`](../tooling/artcraft/runtime-official3-v1.json).
- Root notice entry: `/artcraft/legal/RUNTIME-NOTICE-INDEX.md`; complete upstream notices, conservative dependency/compiler notices and the adopted AFM/AGL/PDFium records remain accessible under the same static prefix.

| Required app | Exact iframe URL                                    | Substantive distribution/asset blocker at this checkpoint                                                                                                                                               | Separate product acceptance                                                                                 |
| ------------ | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| WordCraft    | `/artcraft/wordcraft/0.14.0/index.html?host=parent` | None identified for the unchanged official payload with this exact composed notice set                                                                                                                  | Real backend/SDK/browser lifecycle and format/recovery acceptance                                           |
| GridCraft    | `/artcraft/gridcraft/0.15.0/index.html?host=parent` | None identified for the unchanged official payload with this exact composed notice set                                                                                                                  | Real backend/SDK/browser lifecycle and format/recovery acceptance                                           |
| PdfCraft     | `/artcraft/pdfcraft/0.17.0/index.html?host=parent`  | Earlier AFM/AGL/PDFium evidence is now adopted; no font/mapping implementation replacement is needed for the unchanged payload. Current compatibility behavior is preserved                             | Real backend/SDK/browser lifecycle, PDF fidelity/extraction/redaction and recovery acceptance               |
| DeckCraft    | **No usable runtime entry emitted yet**             | Official 0.14.1 has no verified host bridge. Modified `.1` retains marks. Opus owns mark removal and a distinct version; admit only the resulting coordinated-build payload/receipt, never relabel `.1` | Real correlated native open/save/reopen through backend/SDK, then relevant PPTX/failure/recovery acceptance |

These rows distinguish **express permission/notice obligations** from residual audit confidence. The positive AFM-specific grant and exact width correspondence, BSD-permitted AGL data and file-level BSD-noticed PDFium implementation witnesses support the adopted existing-data composition. Root MIT/Apache labels alone are not used for those data. No numeric/font/mapping behavior is changed. Six WinAnsi undefined-code policies and modern MacRoman Omega/euro/PDF-space semantics remain documented existing behavior; raw PDFium differences are not silently installed. There is no remaining narrow mapping-code blocker for shipping this unchanged official PdfCraft asset with the adopted notices.

Unique historical toolchain or every optimized WASM byte's unique source attribution remains residual confidence, **not an invented blanket distribution condition**. Full audit/legal-opinion flags remain false, not implied clearance. The newly generated runtime manifest has `deployable: true` **only** with `deploymentScope: "verified-static-assets-only-not-product-launch-or-legal-clearance"`; it also fixes `productIntegrationVerified: false` and `allFourLaunchReady: false`. Earlier acquisition/audit/build manifests retain their original false flags as historical checkpoints. Do not require unrelated apps to wait on modified Deck's brand/bridge blocker, and do not call three-app availability all-four launch completion.

### Parent static/asset-gate contract

`runtime-bundle-manifest.json` is externally pinned by exact SHA-256; it is not self-hashed. It has `schemaVersion: 1`, `kind: "artcraft-runtime-static-bundle"`, `purpose: "runtime"`, `mountPath: "/artcraft"`, exact official `editors`, four per-app `readiness` assessments, `notices`, `serving` and global `assets`.

- Each usable `editors[]` entry owns `{ app, version, archiveSha256, index, assetUrl, bridge, deployable, files }`. `bridge` is `upstream-host-parent`; `index` is bundle-relative; `assetUrl` is the exact URL above. `files[]` enumerates every original editor member as `{ path, bytes, sha256 }`, also bundle-relative. Backend `EditorDocument.assetUrl` consumes the verified URL directly; UI must not recreate a version/URL catalogue.
- Global `assets[]` records `{ path, bytes, sha256, contentType, cacheControl }` for **every** file other than the manifest. Its exact set is independently checked against the unchanged audited payload identities and a shared source-verified legal composition, not trusted merely because a mutable receipt lists it. Removing both a notice and its receipt row fails.
- Limits: manifest at most **8 MiB**, at most **10,000** asset files, each at most **128 MiB**, total at most **512 MiB**. Reject duplicate/unsafe paths, links/special/unlisted files or directories, writable/wrong modes, missing/tampered bytes, wrong official identities/URLs, synthetic purpose, false completion claims and changed required notice composition.
- Caddy/static owner strips only the `/artcraft` prefix and serves the corresponding root-relative file. Preserve subdirectories and relative JS/WASM/snippet URLs. Unknown files return **404**, never an app SPA fallback; no directory browsing. Keep manifest/notices accessible. Support ordinary GET/HEAD and ranges, same-origin iframe loading and `X-Content-Type-Options: nosniff`. Never execute or mount uploaded HTML/SVG/documents at this trusted-code origin/path.
- Apply `assets[].contentType`/cache policy. WASM is `application/wasm`, JS `text/javascript; charset=utf-8`, HTML `text/html; charset=utf-8`, ICO `image/x-icon`; legal text is plain text and JSON `application/json`. Indices, manifest, notice documents and un-hashed snippets use `no-cache`; only specifically named hashed `.wasm/.js/.ico/.css` assets use `public, max-age=31536000, immutable`. Do not cache every file immutably just because its containing directory has a version.
- Original marks stay only inside unchanged official editor contexts under the retained brand terms; do not extract them into Hyori branding or suggest endorsement. Modified Deck's distinct terms remain a real blocker, owned by Opus.

The backend and parent have received the exact field/layout/URL/hash contract before runtime integration. The future modified Deck discriminant is reserved as `bridge: "hyori-correlated-host-v1"`, distinct version (expected `.2`), `sourceArchiveSha256`, `buildManifestSha256` and `payloadSha256` instead of an official archive pin; **no such deployable entry is emitted by this slice**. Its canonical payload hash will be SHA-256 of UTF-8 `JSON.stringify(filesSortedByASCIIPath)`, with record keys in order `{path,bytes,sha256}`, no whitespace/newline, including all modified editor payload members under `deckcraft/<version>/` but excluding shared legal files/root runtime manifest. Exact changed artifacts must be built/pinned before enabling that entry. A browser-test fixture is not a production replacement for these pins.

### Exact notice adoption and reproducible commands

The original 130-file supplement and earlier legal bytes are unchanged. `notice-adoption-v1/` now adds **25 exact notice/source/proof files plus its independently pinned index**, SHA-256 **`607e858087a0b64f1bf5e30a9fed7fe14e2aaded394e2f05e163e32b9d09f216`**. This includes all fourteen complete AFMs with the exact accompanying permission paragraph, AGL with its full grant/copyright/disclaimer, complete file-level-noticed PDFium mapping source/headers/LICENSE/AUTHORS, unchanged existing Rust data source, the correspondence receipt and an intelligible adoption/conversion record. AFMs/readme are not modified; their copyright/companion/unchanged-paragraph obligations are preserved. No fonts or mappings are replaced. The adopted delivery grows from the previous **147 to 173 files**. A shared `packageNoticeFiles()` composition feeds official acquisition and the runtime verifier so required old notices cannot silently disappear during repackaging. The retained modified-Deck path also receives the adopted notices but remains nondeployable with marks intact.

```sh
# Offline only: existing public archive cache; destinations MUST NOT exist.
bun scripts/artcraft/content-acquire.ts /absolute/new-adopted-acquisition /absolute/public-archive-config.json
bun scripts/artcraft/content-runtime.ts assemble /absolute/new-runtime-bundle /absolute/new-adopted-acquisition
bun scripts/artcraft/content-runtime.ts check /absolute/new-runtime-bundle EXPECTED_MANIFEST_SHA256
bun scripts/artcraft/content-adoption.ts
bun scripts/artcraft/content-acquired.ts /absolute/new-adopted-acquisition

# Actual built bundle check; no server/container/browser/network operation:
bun scripts/artcraft/content-runtime.ts check tooling/artcraft/.generated/runtime-official3-v1 \
  1bfd3449257f4bd8cf7b6c124817754dda5406e707b26a36a76dff1db318e8fc
```

Repeated independent assemblies produce the same manifest hash. The full ArtCraft regression checkpoint passed **120 tests / 15,361 assertions**, including all local-input acceptance cases, exact adoption/missing/tamper checks, deterministic bundle reproduction, wrong URL/pin/mode/unlisted payload rejection and staging rollback. Scoped TypeScript passed. Root anti-slop is separate: the latest implementation scan reported parallel-owner WIP diagnostics in editor-screen/destination-request files and the Opus-edited `deckcraft-build.ts`/`deckcraft-marks.ts`; those changes are not overwritten here. Final diagnostics are reported at handoff. No live Docker/LAN service, network configuration, UI/backend/SDK/root-CI edit, vendor execution, new product asset, subagent, commit or push was performed. **Do not stop/recreate/clean `hyori-lan-t3-ce2b2e51`.** A Deck build must wait for Opus's exact patch/version and a coordinated restricted-build window.

## Verified upstream contracts

| App       | Released browser package                                              | Host-storage bridge in tagged source                                                                                                                                                                                    |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WordCraft | [0.14.0](https://github.com/storytold/wordcraft/releases/tag/v0.14.0) | [host.rs](https://github.com/storytold/wordcraft/blob/v0.14.0/apps/wordcraft-web/src/host.rs)                                                                                                                           |
| GridCraft | [0.15.0](https://github.com/storytold/gridcraft/releases/tag/v0.15.0) | [host.rs](https://github.com/storytold/gridcraft/blob/v0.15.0/apps/gridcraft-web/src/host.rs)                                                                                                                           |
| DeckCraft | [0.14.1](https://github.com/storytold/deckcraft/releases/tag/v0.14.1) | No corresponding bridge established; [browser entry point](https://github.com/storytold/deckcraft/blob/ee39ff67816d0039143ec7c98ea604cefe0cd2e5/apps/deckcraft-web/src/main.rs) describes local file pickers/downloads. |
| PdfCraft  | [0.17.0](https://github.com/storytold/pdfcraft/releases/tag/v0.17.0)  | [inline host module](https://github.com/storytold/pdfcraft/blob/v0.17.0/apps/pdfcraft-web/src/main.rs)                                                                                                                  |

All four pinned release and source archive SHA-256 values have been verified. Acquisition validates ZIP paths, sizes, compression, checksums, and collisions before extraction; it executes no downloaded scripts. These official JS/WASM artifacts have not been browser-exercised here; the separately modified DeckCraft native fixture below does not validate official binaries or general format fidelity. Historical acquisition/audit records remain `deployable: false`; the later official-three runtime manifest above has a separately scoped static-composition `deployable: true`, without claiming product launch readiness or legal clearance.

WordCraft's [web hosting guide](https://github.com/storytold/wordcraft/blob/main/packaging/web/README.md) documents static hosting, relative asset paths, `.wasm` MIME types, caching/compression and iframe requirements.

## Reproducible acquisition and redistribution evidence

```sh
# Use the repository-pinned Bun 1.4.4.
bun scripts/artcraft/redistribution.ts         # Offline hashes, required notices and provenance checks
bun scripts/artcraft/redistribution.ts --fetch # Re-fetch immutable inputs and reproduce derived notices
bun scripts/artcraft/closure.ts                # Check declared wasm32 graphs and matched notice corpus
bun scripts/artcraft/closure.ts --sources      # Reproduce source-derived closure notices (network)
# Optional verified registry cache: append an explicit CARGO_HOME to --sources.
bun test scripts/artcraft                    # Focused archive/evidence regressions
bun run check:scripts-types
bun scripts/vendor-artcraft.ts /absolute/path/to/new-empty-output
```

The acquisition destination must **not exist**, including an empty directory; the installer refuses to overwrite anything. A fresh sibling installation is atomically renamed into place only on success. Each downloaded archive/source uses its own new staging directory; archive data is validated before members are exposed, and no interpreter/build tool runs inside downloaded directories. Downloads are bounded to the pinned size. The online evidence check rejects changed sources and reproduces the retained derived notices without rewriting legal files.

- `tooling/artcraft/manifest.json`: pinned browser/source archives and original upstream notices/bridge fixtures.
- `tooling/artcraft/redistribution.json`: 38 immutable supplemental source inputs, their sizes/SHA-256, and 84 retained supplemental legal/evidence files with deterministic extraction methods. Four immutable editor lockfiles are retained as evidence, **not** presented as a production dependency closure.
- `scripts/artcraft/redistribution.ts`: offline completeness/hash/provenance checks and optional online source reproduction. It checks original legal/bridge evidence too, before acquisition starts any network request.
- `tooling/artcraft/licenses/REDISTRIBUTION-SUPPLEMENT.md`: corrections and limitations alongside, never in place of, byte-preserved upstream notices.

The acquired bundle includes shared/per-editor supplemental notices under `legal/`, a machine-readable `legal/redistribution.json`, and a human-readable `legal/SYMPHONIA-SOURCES.md` with exact downloadable matching-source archive links, sizes and lockfile checksums. Its artifact manifest hashes these files and states that both exact production dependency closure and full notice audit remain unverified. Local audit-only lockfiles/package metadata are not served as editor assets.

### Concrete evidence now retained

- **Shared egui fonts:** all four lockfiles pin `6d518fc799681571963842f95b55a6b68431b15a`. Exact UFL, Hack MIT/Bitstream Vera, Noto Emoji OFL, and icon-font MIT texts are retained once. Copyright/licence name records are extracted from the exact locked Ubuntu Light, Hack, and Noto Emoji font binaries, including Copyright 2011 Canonical and Copyright 2013 Google. The metadata input and derived output hashes are recorded; no new font binaries are committed. GridCraft's existing full licence bodies and all existing icon-font notices remain unchanged.
- **WordCraft:** checks require the concrete bundled extra-font notices for Inter, JetBrains Mono, Source Sans 3, Source Serif 4, and Noto Sans Georgian, rather than demanding every optional craft-fonts family. Its actual craft-pdf/Krilla lock revision is `92d392cff132eaf53e13afff77f38b5c11b73aa0`; the stale upstream NOTICE is preserved, with the correct revision's attribution and PDF-writer MIT/Apache/ICC legal material retained separately. The complete Polish hyphenation comment header now stands alone with its copyright and MIT permission/disclaimer.
- **DeckCraft:** all sixteen locked Symphonia 0.5.5 packages declare MPL-2.0. Official `.crate` source archives were fetched and checked against Cargo.lock, and their package manifests, VCS provenance, leading per-source notices, and exact upstream MPL text retained. All sixteen identify upstream revision `6d533f26150953a882a6a111ebd13f0abf7129d5`. Source inventories explicitly mark files lacking leading notices. These are locked candidates, **not a claim that all sixteen are linked in every build**. Covered-file source availability obligations do not require relicensing all Hyori under MPL; future modifications need corresponding modified source and updated notices. Source references must stay usable or deployment must supply the corresponding archives itself.
- **PdfCraft:** the vendored Hayro `CGATS001Compat-v2-micro.icc` is byte-identical to Compact-ICC-Profiles commit `bdd84663061bc4ae95ca70decff54f581e27f702`, SHA-256 `73e1ba37d2bad5bab2a964f40a9eed96209666efc067c3322626214bbef234a0`. Its identifying README and complete CC0-1.0 text are retained. Existing Foxit/PDFium and Adobe CMap BSD notices are preserved.

### Locked declared wasm32 graphs and matched notice corpus

`tooling/artcraft/closure/manifest.json` now records the **resolved locked declared target-normal dependency graph and enabled features** for each tagged browser package. These are source-graph results, not a claim to have reconstructed or executed the released binary.

- WordCraft: **225** target-normal packages; **28** additional host-only package identities.
- GridCraft: **172** target-normal packages; **27** additional host-only identities.
- DeckCraft: **236** target-normal packages; **28** additional host-only identities.
- PdfCraft: **363** target-normal packages; **48** additional host-only identities.

The package identities include registry/Git/path origins, not just name/version. `cargo tree --edges normal,no-proc-macro` supplies target feature sets; a separate `normal,build` tree supplies host-inclusive package identities. Host-only identities are the set difference. Features from host/build units or workspace-wide `cargo metadata` are **never unioned into the normal target feature sets**. Packages used on both sides can have different host features; the host-inclusive tree is retained without treating those features as shipped-WASM features. Dev dependencies are not part of these trees.

All four resolutions used explicit installed **Cargo 1.99.1 / rustc 1.99.1**, from the trusted Hyori repository working directory, with `--manifest-path` pointing into freshly validated/extracted source. Metadata used `--locked --filter-platform wasm32-unknown-unknown`; trees used `--locked --target wasm32-unknown-unknown -p <app>-web`. Compiler/wrapper environment is explicitly controlled. No downloaded wrapper, `build.rs`, Trunk, package script, or upstream binary was executed. A wasm32 standard-library installation was not required for graph resolution. All commands completed successfully; there is currently **no unresolved crate/revision graph-resolution blocker**.

#### Exact tagged build-recipe provenance

The tagged release workflows deliberately reference `craft-common-actions/.../release.yml@main`. Their successful run records establish the actual reusable-workflow revision **`44a7db40b1a3e99eed02c88f89f38cdd6cfffe81`**, rather than substituting today's `main`:

- WordCraft [run 41339306129](https://github.com/storytold/wordcraft/actions/runs/41339306129).
- GridCraft [run 41339254501](https://github.com/storytold/gridcraft/actions/runs/41339254501).
- DeckCraft [run 41340717822](https://github.com/storytold/deckcraft/actions/runs/41340717822).
- PdfCraft [run 41339333094](https://github.com/storytold/pdfcraft/actions/runs/41339333094).

The pinned shared workflow invokes each tagged `packaging/web/package.sh`. WordCraft, DeckCraft and PdfCraft use `trunk build --release` from `apps/<app>-web`; GridCraft additionally passes `--dist "$SITE" --public-url ./`. The reviewed Trunk manifests/HTML selectors request default features and no additional CLI features. Only WordCraft enables the shared workflow's `web-craft-fonts` input. The shared workflow declares Trunk 0.21.14 and the `stable` Rust channel. Successful-run API responses are explicitly labelled **observed snapshots**, not immutable source files; their retained bytes and run/head/referenced-workflow identities are checked.

`closure-recipe.ts` is a narrow allowlist for these reviewed commands and selectors, not a shell/YAML interpreter. Changes to feature controls, binaries, hooks or packaging target/feature environment fail closed. The raw recipes, root manifests/lockfiles, build-script text, normalized Cargo metadata, both trees and exact commands/stderr are retained under `closure/evidence/` for reproduction.

#### Source-matched notice installation

The union of the normal and conservative host-inclusive graphs contains **540 package identities**. The new corpus retains **3,471 hashed files**, including **2,435 legal/discovery files**, from **457 source/observation pins**: 422 registry archives matched to Cargo.lock checksums, four editor archives, four immutable Git dependency archives, 23 immutable raw files, and four release-run snapshots.

For every package, the corpus preserves discovered LICENSE/LICENCE/COPYING/COPYRIGHT/NOTICE/AUTHORS/UNLICENSE files, attribution/acknowledgment/contributor/third-party notices, SPDX `LICENSES/` directories and licence sidecars, plus a source copyright/SPDX-line inventory with source-file hashes. A NOTICE/AUTHORS/attribution-only discovery does not suppress the search for a permission-text candidate; omitted licence bodies still trigger source-matched supplementation. Omitted repository licence texts are supplemented only from the registry archive's checksummed `.cargo_vcs_info.json` revision, never from a current branch. Package manifests and VCS records are retained. No package is silently treated as first-party merely because Cargo represents a vendored dependency with a path source. The previously blocked `num_enum` GNU long-name archive is handled by bounded path validation, not an external extraction command.

All 540 package inventories now have concrete notice material; none has a missing-standalone-text or safe-archive-reading blocker. **Every inventory still has status `harvested-pending-content-audit`**. Filename discovery, SPDX expressions and copyright-line inventories do not themselves establish complete licence obligations or account for all embedded assets. The source archive references and member/input/output hashes allow the notice bytes to be independently reproduced. Source verification reproduces the derived notices from all **453 immutable/checksum-pinned source inputs**, using separately staged, checksum-verified registry-cache copies where available and network downloads for other sources. The four mutable release-run observations are instead verified as retained snapshots, including their exact local hashes and required provenance fields; neither collection reruns nor source reproduction need to reinterpret a current API response as immutable evidence. Previously verified discovery locations are reused only at the same checksummed package VCS revision, with their notice bytes re-fetched and hash-checked. New GitHub licence discovery uses a pinned, validated source archive rather than depending on the GitHub tree API's quota. Existing legal files and earlier redistribution evidence remain unchanged.

Acquisition now installs the corpus under `legal/closure/packages/`, with `legal/closure.json` and `legal/DEPENDENCY-NOTICES.md`. The deployment copy excludes local compiler paths, machine usernames, raw Cargo metadata, command logs and other audit-only files. All installed files are individually hashed in the artifact manifest. The older `redistribution.json`/supplement remains a preserved earlier evidence snapshot; the new closure record describes this additional progress.

The acquisition manifest separately pins the SHA-256 of the entire retained closure manifest. Removing both a notice and its inventory reference therefore cannot silently weaken acquisition checks. A deliberately adopted regenerated corpus requires an explicit review/update of that pin; regeneration itself never rewrites acquisition contracts or an existing output.

To reproduce graph resolution and collection without executing upstream code:

```sh
# Select explicit binaries from an already installed Rust toolchain.
TOOLCHAIN_DIR=/absolute/path/to/installed/toolchain/bin
bun scripts/artcraft/closure-collect.ts /absolute/path/to/nonexistent-output \
  "$TOOLCHAIN_DIR/cargo" "$TOOLCHAIN_DIR/rustc" /absolute/path/to/cargo-home
```

The output destination must not exist. The collector bounds downloads, entry counts and expansion, validates complete archives before extraction, validates the exact Git PAX commit header and only narrowly supported GNU long regular-file names, rejects links/path overrides/traversal, and keeps its own tooling and subprocess working directory outside downloaded trees. It never rewrites a lockfile or relaxes `--locked`. Failed graph commands are retained as machine-readable incomplete gates with exact command/stderr instead of being converted to a complete graph.

### What remains unverified

1. **Exact correspondence to the released JS/WASM:** the tagged packaging commands do not pass `--locked`; their Rust channel and some build actions/tools are dynamically selected. The retained source graph is exact for the documented locked resolution, but no link/build attestation proves that every shipped byte used precisely that graph. Tree inclusion also does not prove which code survives WASM linking/dead-code elimination.
2. **Full third-party content audit:** per-package copyright/permission/NOTICE content, generated-code obligations and embedded material still need review against the resolved target features. In particular, harvesting root licences is not clearance for generated Unicode/ICU data, encoding tables, font/profile assets, source-only code generation, or other separately licensed material. The retained source inventories identify candidates, not a complete asset scanner. The existing concrete font/ICC/Symphonia supplements remain necessary.
3. **Compiler/build-generated output:** Cargo's package graph does not audit Rust std/compiler-builtins or additional Trunk/wasm-bindgen/Binaryen-generated JS/WASM and the exact tools used to produce it.

Root MIT/Apache licences, broad Cargo.lock inventories, Cargo-deny and the new filename-based notice harvest are **not** full legal-completeness evidence. The retained craft-libs attribution includes optional/test material; retaining it does not establish production embedding. No full legal-audit completion is claimed.

Production browser/format-fidelity coverage, real SDK-backed DeckCraft storage integration, full build/notice audit and protected-mark removal remain gates. The separately versioned experimental build and native fixture below do not clear those product/deployment gates. No visual assets or protected marks were changed.

## Message protocol established in source

> **Since protocol 3**, Hyori embeds every editor in a sandboxed, opaque-origin frame; the same-origin descriptions below record the upstream bridges and earlier Hyori protocols. See [protocol 3](editor-runtime-protocol.md#sandboxed-frame-protocol-3).

WordCraft, GridCraft, and PdfCraft support `?host=parent` in a same-origin iframe. Each prefixes its messages with its application name:

- `:ready`: the parent may send a document.
- `:open`: parent sends `{ name, bytes }`, with ArrayBuffer/Uint8Array bytes.
- `:save`: child sends `{ name, bytes }`; WordCraft/PdfCraft also distinguish `saveAs`.
- `:dirty`: child reports unsaved changes.
- `:failed`: child reports startup failure.

The source checks both message origin and sender window. Hyori's future host adapter must do the same. Treat export/Save As separately from replacing the opened cloud file. A child reporting clean does not prove the parent persisted its save; the host must own visible pending/failure/retry behavior and retain unsaved bytes until persistence succeeds.

## Bounded content and compiler-generated notice audit

The 2026-11-05 content slice examines the **actual four official distributions plus the unchanged modified Deck build**, rather than treating Cargo metadata or licence filenames as content clearance. Full findings and exact open work are in [`tooling/artcraft/content-audit/REVIEW.md`](../tooling/artcraft/content-audit/REVIEW.md). This is technical redistribution evidence, **not a legal opinion**. All deployment/full-audit/compiler-generated-audit/marks gates remain false.

### Completed content evidence

- **68 actual distributed members:** every regular ZIP member of WordCraft (26), GridCraft (13), DeckCraft (12), PdfCraft (11), plus the six-file modified Deck payload. Static HTML/CSS/JS, hosting/docs/notices, icons and compiled WASM are individually accounted for.
- **54 structurally identified embedded sfnt instances**, with actual copyright/licence/name records, source-table-extent identities and governing notices. This includes the separate egui icon subset and parent font, app fonts and the source-matched external Georgian font; Type1 fonts are handled separately. Instances are not counted as distinct typeface families.
- **481 exact embedded source-byte regions independently reverified** against the actual pinned WASM data segments. Findings include dictionaries/patterns, SVGs, shaders/CSS, Type1 fonts, compressed CMaps, profiles and translation data. Negative byte searches do not establish absence after transformation/compression.
- **Compiler inputs outside app Cargo metadata:** all five producer sections identify Rust 1.99.1, wasm-bindgen 0.2.129 and Walrus 0.27.2; Rust source fingerprints match `58cf8f9c35b355199727627d07ae34a4e2846d67`. A separately checksum-pinned **9,392,879-byte Rust source component** supplies 3,608 source-member copyright/permission records and 127 retained complete licence/source members. These source records conservatively include unlinked/test/platform-specific material; they do not make every listed licence applicable to Hyori.
- **External WordCraft translations:** 61 relevant catalogs at `craft-i18n@9205108cfdced5177706264038848b68b2422d2b`, 54 directly byte-observed, with source-specific MIT/Apache and translator attribution. The other seven are not declared absent or linked.
- **5,568 machine-checked dispositions and 1,180 exact evidence references.** Of the dispositions, 350 have reviewed notice evidence, 3,981 retain conservative evidence, 1,228 remain unresolved, seven retain a marks/context gate, and two identify unshipped transformation tools. Many unresolved rows are source/include candidates rather than proven shipped material or independent legal violations. Every row carries its exact source/member and action; there is no blanket clearance of all 540 earlier package inventories.

The review reads actual obligations, not just SPDX labels: UFL naming/no-trademark terms; OFL copyright, reserved-name and no-standalone-sale conditions; Hack's MIT/Bitstream/DejaVu combination; Lucide ISC **and** Feather MIT; Foxit/Adobe BSD conditions; source-specific ICC/CC0 statements; actual MIT/BSD hyphenation headers; WHATWG data terms distinct from encoding code; and Unicode/ICU/CLDR copyright and adaptation notices distinct from generator licences.

**Compiler-builtins is MIT AND Apache-2.0 WITH LLVM-exception**, not Rust's general MIT-or-Apache choice. Its complete conjunction/exception, compiler-rt credit statement, libm/musl/CORE-MATH attribution and per-file math clauses are retained. The LLVM embedded-object exception does not discard the separate MIT notice requirements. Two Sun permission blocks occur after attributes/imports in `rem_pio2_large.rs` and `erf.rs`; both were inspected and included rather than lost by a leading-comment-only extractor.

Generated output is separately assessed: wasm-bindgen copied JS, Trunk loader templates, upstream dependency snippets and the modified host bundle's Zod MIT. The shared 280-byte eframe snippet is matched byte-for-byte to the decoded literal in pinned `crates/eframe/src/web/text_agent.rs`, with egui/eframe copyright/permission evidence. Binaryen/Walrus transformations are not automatically treated as shipped runtime libraries or a reason to apply every tool dependency's licence to output. Exact official Trunk/Binaryen correspondence remains unverified; the modified build retains its own exact pins.

### Machine checks and notice supplement

`content-audit/index.json` pins the audit and discovery records. Checks enforce one disposition for every discovered item, evidence bytes/hashes, separate font permission bodies, the compiler-builtins conjunction/exception, explicit unresolved actions, and still-false approval gates. Tests reject removing both a material and its claimed ID, altered evidence, metadata-only font coverage, umbrella-licence substitution and unsupported Adobe-data clearance.

```sh
bun scripts/artcraft/content-audit.ts
# Public-only config: four { app, sourceArchive, releaseArchive } entries,
# publicCargoCache, and the existing modifiedDist; no credentials/user data.
bun scripts/artcraft/content-artifacts.ts /absolute/public-input-config.json
bun scripts/artcraft/content-notices.ts /absolute/nonexistent-notice-output
bun test scripts/artcraft
bun x --no-install tsc --project scripts/artcraft/tsconfig.content.json --noEmit
bun x --no-install tsc --project scripts/artcraft/tsconfig.deckcraft.json --noEmit
bun run lint:anti-slop
```

The generated **130-file notice supplement** has 71 original-byte permission/condition texts, 56 compiler source-notice files, observed-font copyright text, explanatory scope and a hash manifest. The notice manifest reports no omitted reviewed source-prefix clauses. A generated preview exists locally at `tooling/artcraft/.generated/content-notice-pack-2/`; the authoritative audit/evidence remains under `tooling/artcraft/content-audit/`.

The supplement is now integrated into **local acquisition**, as described below; runtime delivery/publication remains unimplemented and unauthorized. Retention or acquisition alone does not prove a deployed bundle contains required notices. Official pins and all earlier legal/vendor/patch/build bytes are unchanged. Audit reproduction remains split into authored `content-discover.ts`, `content-fetch.ts`, `content-extra-fetch.ts`, `content-rust.ts` and `content-curate.ts`; the collectors fail closed on reused output directories. Source inspection remains static, with no vendor builds/instantiation on the host and no unchanged Deck rebuild.

### Finite local notice-delivery integration

`tooling/artcraft/notice-supplement/` retains the **exact original 130 generated files**, not a rewritten rendering of their notices. Its independent acquisition index SHA-256 is **`1c831022e11e86fd04ee67090f1291b615d4f10e9ffe13ec3908c5ea8b1aa906`**, pinned in `content-delivery.ts`; that index also pins the source audit index. Acquisition checks this pin, every file's length/hash, exact reproduction from verified retained evidence, and the complete expected file set. Removing both a notice and its own catalog entry fails the independent pin. Links, special files and unaccounted files are rejected. The original generated snapshot's “not yet wired” prose is preserved as historical text; the new local index explicitly explains the later integration.

Both `acquireArtCraft(destination)` (unchanged public signature and official pins) and the retained modified-Deck path include **147 notice-delivery files**: the frozen 130-file supplement, 12 additional whole-file attribution/copyright/NOTICE witnesses, and five local index/coverage/correspondence records. In particular, external translation attribution is not lost merely because its evidence role was provenance rather than permission text. The existing upstream LICENSE, permission, copyright, NOTICE and attribution files remain byte-preserved alongside these additions.

- `legal/NOTICE-INDEX.md` is the human-readable entry point, with local links to every supplement notice and additional whole-file witness.
- `legal/content/notice-manifest.json` preserves original source/member/hash entries; `legal/content-supplement-index.json` preserves the independently pinned acquisition catalog.
- `legal/content-coverage.json` carries all 5,568 frozen dispositions, local notice references, explicit retained-only evidence references and unresolved actions. It points to the later mechanical correspondence receipts without silently rewriting the old audit's decisions.
- `legal/DATA-CORRESPONDENCE.json` and `legal/PDFCRAFT-DATA-CORRESPONDENCE.json` retain the narrowly resolved source-version/identity and numeric-table observations described below.
- The enclosing artifact manifest hashes every delivered file. It explicitly records local notice delivery only; `runtimePublication`, deployment, full content/compiler audit, legal-opinion and marks-clearance flags remain false. The complete multi-editor supplement is copied conservatively into each acquisition; this does not assert that every listed material ships in every editor.

Local evidence is verified **before downloads or installation creation**. Offline acquisition never falls back to fetching. Existing non-overwrite, fresh per-archive staging, official size/SHA-256 pins, ZIP validation, atomic successful assembly and failure cleanup remain in place. The retained Deck assembler reads only artifact members named in the verified historical build receipt, checks their exact sizes/hashes and the audited payload identity, preserves that receipt verbatim, and adds notices in a new destination. It does not run Cargo, Trunk, Docker or downloaded code. `deckcraft-build-evidence.ts` also uses the shared verified notice composition for future evidence assembly; no build was rerun here.

```sh
# Four distinct { app, releaseArchive } entries; existing public-input configs also work.
# No downloads, builds, servers or runtime publication:
bun scripts/artcraft/content-acquire.ts /absolute/new-official-output /absolute/public-archive-config.json
bun scripts/artcraft/deckcraft-acquire.ts /absolute/new-deck-output /absolute/existing-build-evidence
bun scripts/artcraft/content-acquired.ts /absolute/new-official-output
bun scripts/artcraft/content-acquired.ts /absolute/new-deck-output
bun scripts/artcraft/content-delivery.ts

# Optional large-payload acceptance inputs; without them only these five acceptance tests skip.
ARTCRAFT_TEST_INPUTS=/absolute/public-archive-config.json \
ARTCRAFT_TEST_DECK_EVIDENCE=/absolute/existing-build-evidence \
bun test scripts/artcraft
```

Both actual local assemblies were created and independently notice-verified at `tooling/artcraft/.generated/notice-delivery-official-1/` and `tooling/artcraft/.generated/notice-delivery-deck-1/`. Each has `artifact-manifest.json` and `legal/NOTICE-INDEX.md`; neither is a runtime mount or authorization to distribute. The latter still contains the unchanged `f472a886…` Deck WASM. Tests exercised the public acquisition call using a wholly local cached downloader, the explicit offline official path and retained Deck assembly, hashing all installed assets and comparing original notices. They reject tampered/missing notice bytes, removal of bytes plus their receipt row, false clearance, links/extra files, changed/missing retained payloads and overwrite attempts; failed Deck assembly leaves no destination/staging residue.

### Mechanically answered source/data questions

[`tooling/artcraft/pdfcraft-data-decision/DECISION.md`](../tooling/artcraft/pdfcraft-data-decision/DECISION.md) is the concise decision record: exact source claims, nine checksum-pinned source/permission witnesses, source consumers, viable replacement paths and their compatibility costs. **No replacement is implemented or selected.**

The whole `.rs` file not appearing in WASM never established data absence. A narrow static serialization check now **positively observes the complete 7,168-byte 14 × 256 standard-font width matrix and all three 1,024-byte encoding arrays in the pinned official PdfCraft WASM**. Exact offsets, hashes and overlapping per-row checks are in `compiled-tables.json`. These four whole-table observations are additional to, not a replacement for or renumbering of, the earlier 481 exact source-byte regions. Presence is now mechanically established; unique source origin, upstream rights and exact provenance are not thereby established. The separately compiled glyph-name `NAMES` representation is not declared absent or correspondence-verified.

`correspondence.json` also resolves **29 explicit source-version declarations** and **28 identical-source groups with positive output observations**. Retained ICU data headers identify CLDR 48.2.1, ICU release-78.1rc and LSTM v0.1.0. Unicode normalization 0.1.25 declares 17.0.0 while 0.1.26 declares 18.0.0; a blanket assumed Unicode version would be wrong. The same Word `numbers.postcard` bytes occur in two craft-libs revisions, so data identity is established but those bytes cannot select the originating revision. Declared versions do not independently reproduce the upstream transformations or prove linkage of every source candidate.

```sh
bun scripts/artcraft/content-correspondence.ts
bun scripts/artcraft/content-pdf-tables.ts /absolute/pinned-pdfcraft-release.zip
```

The integration checkpoint passed **107 tests / 15,061 assertions**, including all five cache-dependent acceptance tests with local inputs supplied; content and Deck scoped TypeScript, scoped formatter/lint, old retained checks, actual 68-file/481-region verification and both local notice checks passed. Root anti-slop is reported separately from functional evidence: the final run passed with no diagnostics. An earlier run found three transient active-owner diagnostics in `scripts/metadata-query-experiments.ts` (unparsed `raw` input and two spacing diagnostics); those are no longer present in the final scan, and that out-of-scope file was not edited by this slice. No network requests, containers, browser sessions, servers, root CI/package scripts, SDK/UI/backend edits, subagents, commits or pushes were used in this integration slice.

### Bounded standard-font source-data feasibility

The later [finite feasibility record](../tooling/artcraft/font-data-feasibility/FEASIBILITY.md) narrows the old PdfCraft data blocker without reopening the broader audit. It retains exact source/permission inputs, existing parser APIs, numeric proofs, and affected consumers/tests. No replacement is selected or implemented; the old audit and 147-file acquisition composition stay frozen.

**Positive existing-data evidence now exists.** An asset-specific companion paragraph expressly permits using/copying/distributing the fourteen Adobe core-font AFMs with or without modification, subject to preserving copyrights, the companion file and its unchanged permission paragraph, and prominent modification notices. All fourteen complete AFMs and their copyrights are retained at immutable Matplotlib mirror revision `f9db3d8c59a8453601ad81514f9c295d6ec050e1`. Their metrics reproduce **all 3,584 current slots**, under the explicitly disclosed comparison encoding/undefined-code policy. All **231 current glyph-name mappings** also match the separately BSD-permitted Adobe Glyph List. Accept that supported positive existing-data basis before requiring width replacement merely because the grant was previously missing. This is not legal clearance or adoption into the frozen notice package; original historical author inputs remain distinguished from a now-reproducible positive basis.

**Foxit availability is not equivalence.** Static bounded CFF1 metadata/literal-prefix decoding accounts for all 3,210 glyph widths in the fourteen previously retained programs and all 14 × 256 comparison slots: **3,568 equal, 16 different, zero unknown**. Undefined slots use explicit zero policy, not a claimed extracted glyph width. Per-difference offsets/literals/nominal-width proofs are in `font-data-feasibility/result.json`. For example, Helvetica Euro measures 667 rather than the current canonical 556. Broader name-based fallback also matters: the text-face charsets lack 84–86 names present in the corresponding AFMs. These are parsed-name-set differences, not negative byte-search absence claims.

**Existing APIs already supply widths.** Hayro's locked `read-fonts 0.44.0` via `skrifa 0.47.0` returns a width from `CffFontRef::evaluate_charstring`/`draw`, but its wrapper discards that result. Separately, the actual `pdfcraft-fonts` dependency is `skrifa 0.44.0` / `read-fonts 0.41.0`; that already exposes the same width-returning raw CFF API. Both exact source boundaries are retained from checksum-pinned crates. No new production parser dependency is necessary, and no hypothetical adapter was compiled/run.

**BSD-noticed mapping implementations are positively retained.** PDFium revision `a84323421e94f484faca52dd9d027934eba42ab8` supplies a file-level BSD notice and complete LICENSE for its mappings. Direct numeric tables match current WinAnsi **250/256**, MacRoman **239/256** and Standard **256/256**. Joining PDFium glyph names with separately permitted AGL data gives **250/256**, **254/256** and **256/256** respectively. The six WinAnsi differences are PDFium bullet aliases versus current undefined zeros. The two joined MacRoman differences are Omega normalization at `0xBD` and euro/currency at `0xDB`; retained Apple change-history context explains those updates, but is not treated as an express permission grant. The PDF-specific ordinary-space rule at `0xCA` is separately preserved as a compatibility decision.

The minimal technical path is now **positive evidence/notice adoption and explicit semantic-policy confirmation, not automatic width replacement**. If a later decision still requires mapping replacement, `crates/fonts/src/encodings.rs` is the narrow data boundary; all differences and sorted `NAMES` lookup behavior must be explicit. A Foxit-width replacement affects `std14_metrics.rs`/`std14.rs` and potentially font serialization/rendering consistency because of the 16 differences; it is not a safe two-file substitution. Direct consumers in `fonts/src/{std14,lib,pdf}.rs`, 55 bounded reference witnesses, and acceptance requirements for appearances/forms/annotations, text editing, extraction/search/redaction, OCR/XFA, Symbol/Dingbats, glyph-name fallback and save/reopen are recorded in the feasibility note. The reference list is not an exhaustive Rust alias/re-export call-graph proof. No UI changes are proposed or performed in this slice.

```sh
# Fully offline checks against retained source/data, no vendor execution or rendering:
bun scripts/artcraft/content-font-feasibility.ts
bun test scripts/artcraft/content-font-feasibility.test.ts
```

The feasibility checkpoint passed **115 tests / 15,145 assertions** across the full ArtCraft suite, including all five local-cache acquisition acceptance tests, plus content/Deck scoped TypeScript, scoped formatter/lint and root anti-slop. New regressions cover explicit/default widths, fixed literal subroutine prefixes, malformed/cyclic/unsupported input, bounded decoding, exact AFM/CFF/mapping differences, source-specific permission evidence, witness tampering/missing bytes and false clearance gates. Only bounded public source/licence/metric-text research used the network; all later checks are offline. No new product asset, vendor/patch/build/pin change, Rust/C++ execution, Docker/browser/server, SDK/UI/backend/root CI/package-script edit, subagent, commit or publication was performed.

### Exact remaining blockers

1. **PdfCraft data-evidence adoption is now composed:** `notice-adoption-v1` and the current runtime handoff above preserve the positive AFM/AGL/PDFium grant/copyright/correspondence evidence and document existing mapping compatibility behavior. There is no remaining data implementation replacement blocker for this unchanged official payload; historical audit rows remain snapshots, not a veto on unrelated/current supported assets. Exact historical-generation provenance is residual confidence, not conflated with the reproducible basis; no legal clearance or claim about copyrightability/unlawfulness follows.
2. **Generated/transformed content provenance and source linkage:** remaining per-version Unicode/data, dictionary/profile/catalog assertions and opaque WASM regions are explicitly bounded by individual records. Resolve those applicable to the selected distribution; do not turn every unobserved optional/test/source candidate into an asserted runtime obligation.
3. **Runtime notice delivery:** local official/retained-Deck acquisition is now notice-integrated and verified, but nothing was mounted, enabled or published. A future authorized runtime composition must preserve and expose the acquired notices. Raw official ZIP notice gaps remain distinct from corrected local package composition.
4. **Marks and integration:** Opus retains protected-mark/UI ownership. Real authorized backend + public SDK + actual WASM lifecycle, cross-browser/mobile coverage and format fidelity remain separate acceptance gates. The parent SDK contract checkpoint does not clear legal or browser/backend gates.

At the initial bounded content-review checkpoint, the ArtCraft suite passed **97 tests / 516 assertions** and its scoped/root checks passed. The later local-integration checkpoint and separate active-owner diagnostics are reported above; the older checks are historical, not a claim that today's whole-tree diagnostics are absent. React Doctor is not claimed: no React/UI implementation was changed here.

## Separately versioned modified DeckCraft build

The experimental artifact identity is **`0.14.1-hyori-host.1`**, not the official `0.14.1` release. Its source starts at `ee39ff67816d0039143ec7c98ea604cefe0cd2e5` and the existing SHA-256-pinned tagged source archive. `acquireArtCraft(destination)`, official release pins, and their `blocked-no-host-bridge` status are unchanged. A successful experimental build is not authorization to deploy or publish it.

### Reproduction and isolation

```sh
# Run authored tooling from the trusted repository, never from extracted source.
# Destinations must not exist. Use Bun 1.4.4 and explicitly selected public-only inputs.
bun scripts/artcraft/deckcraft-tools.ts /absolute/new-tools /absolute/pinned-bun
bun scripts/artcraft/deckcraft-build.ts /absolute/new-staging \
  /absolute/public-only-cargo-cache /absolute/new-tools /absolute/verified-deckcraft-source.tar.gz
bun scripts/artcraft/deckcraft-container.ts /absolute/new-staging /absolute/new-tools
bun x --no-install tsc --project scripts/artcraft/tsconfig.deckcraft.json --noEmit
bun test scripts/artcraft
```

`tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json` pins the linux/amd64 Rust base image by manifest/config digest, Rust 1.99.1 and its wasm32 standard-library archive, Trunk 0.21.14, wasm-bindgen 0.2.129, Binaryen 123 and Bun 1.4.4. Tool archives are checksum-checked and fully path-validated before selected members are written. Rust component installers are not executed. Publisher checksum/asset-digest evidence is recorded; detached-signature/SLSA verification is **not** claimed. The retained `tool-help.txt` comes from version/help probes inside the restricted offline container, not host execution of downloaded binaries.

The preparation records every source/cache payload hash, checks registry archives against the unchanged Cargo.lock, validates all archive paths, copies only locked public sparse-index entries, and sanitizes public bare Git caches to object/ref data plus a minimal authored config. It excludes user Cargo configuration, credentials, hooks, SSH material, existing checkouts and the repository itself. Cargo's locked workspace resolver required inactive-platform package archives as well as the filtered browser graph; providing these does **not** mean they are compiled into WASM. The source patch adds no Rust dependency and preserves Cargo.lock.

Compilation uses a disposable UID 1000 container, read-only root, no network, dropped capabilities, no-new-privileges, default seccomp, bounded memory/CPU/processes, and only dedicated synthetic/vendor input, authored driver, work and output mounts. There is no Docker socket, whole-repository, home, secret or application-data mount. The authored driver is outside vendor source and invokes explicit Cargo manifests/Trunk configuration from `/driver`. Upstream build scripts execute **only inside this container**. It records complete commands, environment, stdout/stderr, statuses and elapsed times. It invokes release-mode Cargo with `--locked --offline --target wasm32-unknown-unknown` and Trunk with `--locked=true --offline=true`; tooling downloads during compilation are prohibited. A single build does not prove bit-for-bit rebuild reproducibility.

### Actual build and browser results (2026-11-05)

The build **completed**, not just graph resolution. Retained run evidence is in `tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/`: `result.json`, the full input/hash inventory, command environments/results/stderr, resolved graphs, generated bridge-source snapshot, Zod MIT text/package version, and browser result/events/version. Large local build/bundle/notice outputs remain under `tooling/artcraft/.generated/` and are not approved distributable assets.

- **Cargo release wasm32 build:** exit 0, 414,136 ms under the recorded container limits. Metadata and both trees also exited 0. **Trunk:** exit 0, 598,012 ms. These are observed build durations, not product performance benchmarks.
- The filtered metadata list alone was insufficient for Cargo's locked workspace resolver: initial metadata/build attempts exited 101 for missing `accesskit_atspi_common 0.21.0`. Preparation was corrected to supply **575 locked checksum-verified registry archives**, including inactive platforms; it did not enable network compilation or relax the lock. Actual normal graph: **236** package identities, with **264** host-inclusive identities. Target features and host identities exactly match the earlier retained DeckCraft notice graph after normalizing source paths.
- Cargo.lock SHA-256 stayed `91594bc6b91f1501b9bd1330e46cfaa262b8c757359880786dbe098e8fc1ace4`. Current Rust patch application plus the retained generated JS reproduces **every compiled source file byte-for-byte**. This source replay is verified; an independent bit-identical full binary rebuild is not.
- The first Docker attachment hit its 600-second background limit. The same restricted container continued; a separate `docker wait` returned **0**. No replacement privileged/networked build was used. The disposable container exited and was automatically removed.
- Modified browser WASM: `tooling/artcraft/.generated/deckcraft-host-evidence-1/artifact/deckcraft-web-de9427b6c05d565f_bg.wasm`, **32,283,598 bytes**, SHA-256 **`f472a886c58d7a0fd93dbb6017bbfc7b670e8676bd776c801b489dbca38b2e13`**.
- Browser glue JS SHA-256: `c586cf237a2434e9b7aac94f559d703c5e6dabf27b2b880c635aac178b8d5f43`. Host bridge JS is 187,343 bytes, SHA-256 `34579610572be4abd0696075e7d5dd3f63bb12f725f47ef54ef76533eab3f19d`; the exact generated source is retained as `run-2026-11-05/host-bridge.js.source` (data, not a host-executed script).
- The distinct local bundle includes the checked DeckCraft/egui/Symphonia supplements, notices for the selected **264** source-package identities, original DeckCraft NOTICE/ATTRIBUTION/legal material, and Zod MIT. Rust std COPYRIGHT/MIT/Apache and wasm-bindgen MIT/Apache tool-archive inputs are retained under the local evidence bundle's `tool-legal-inputs/`. This remains a notice-input collection, **not** full third-party-content or compiler-generated-output clearance.

The ordinary automated headless fixture used installed **Chrome 156.0.8078.4**, with a fresh temporary profile, OS sandbox intact, software WebGL, and an ephemeral **127.0.0.1-only** synthetic server. It did not launch the Hyori app or expose a LAN service. The first fixture failed because CDP navigation destroyed its execution context; the driver now waits for the actual page loader. The final fixture **passed**:

1. Real compiled WASM opened a tiny generated native `.deckcraft` document, then acknowledged parsing.
2. A real editor keyboard action created another slide; Ctrl+S returned a native two-slide snapshot to the synthetic parent.
3. Another real editor action changed the model while that snapshot awaited acknowledgement. Acknowledging the older snapshot kept `dirty: true`.
4. A second save captured the three-slide document; acknowledging it allowed explicit fixture teardown.
5. A **fresh** same-origin WASM iframe reopened the returned native bytes, then serialized a three-slide document again. No browser download was attempted.

Synthetic input SHA-256: `953416e28f240c7dde04af1eec880dbb59ef3ae7ab9ed35e552f98a868a9bc80`; first saved snapshot: `650adf55cd59bcbf70050a0525c6f84da11e6967a8a9daf9e34ec1481df215b0`; reopened three-slide output: `566a4df97017153cc8fef7aa06898df7e6e56ad1a1d34503448a2269c6ccdeed`. Both browser and temporary server are closed in `finally`. These acknowledgements are synthetic: **real SDK/backend durability, browser conflict/revocation integration, cross-browser/mobile coverage, and PPTX fidelity remain unverified**. Conflict/failure retention, spoofed origin/source/version, stale IDs, buffer copies/bounds, descriptor permissions and pending-save behavior have executable protocol unit coverage.

To repeat the exact bridge-source input rather than rebundle later TypeScript edits, append the retained module path and SHA-256 to the preparation command:

```sh
bun scripts/artcraft/deckcraft-build.ts /absolute/new-staging \
  /absolute/public-only-cargo-cache /absolute/pinned-tools /absolute/verified-source.tar.gz \
  tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/host-bridge.js.source \
  34579610572be4abd0696075e7d5dd3f63bb12f725f47ef54ef76533eab3f19d
# Then run deckcraft-container.ts with the new staging root and pinned tools.
bun scripts/artcraft/deckcraft-browser.ts /absolute/modified-dist \
  /absolute/installed-chromium /absolute/new-browser-evidence
```

Offline retained-run checks are available as `bun scripts/artcraft/deckcraft-run.ts`; they verify **33 retained files**, required evidence and the still-false deployment gates. The focused ArtCraft suite passed **81 tests** (413 assertions), including 17 protocol tests and retained-run tamper/deployment-claim regressions. The focused DeckCraft TypeScript configuration and scoped formatter/anti-slop checks passed. At handoff, root `check:scripts-types` and `lint:anti-slop` also reported separate, out-of-scope browser/service-fixture WIP diagnostics; those files were not changed by this slice. Full root-green status is not claimed.

No startup/serialization performance claim is made: the 32 MiB WASM, synchronous native parsing/serialization, model expansion and multi-copy memory footprint still need representative-device budgets and profiling before product integration. No React/UI files were changed by this slice; the local React Doctor gate remains applicable to the separate UI owner's changes, not asserted as covered by this Rust/transport fixture.

### Host bridge contract and SDK owner handoff

The patch preserves the existing `deckcraft:ready/open/save/dirty/failed` family and adds protocol **1**, exact modified asset `version`, and correlated acknowledgements. Host mode is opt-in `?host=parent`, requires the exact same-origin parent window, and checks **both** `MessageEvent.origin` and `MessageEvent.source`. Standalone picker/download behavior is retained outside host mode. In host mode ordinary Save, direct `file.save`, Save As and the shared export/download path queue bytes to the host, never a surrogate browser download. Media insertion retains the existing picker; document File/Open reports that a fresh host attachment is required. This is trusted same-origin executable vendor code: `allow-scripts` plus `allow-same-origin` is not an isolation boundary for untrusted uploaded content.

The host sends:

```ts
{ type: "deckcraft:open", protocol: 1, version: "0.14.1-hyori-host.1",
  openId, name, bytes, maxBytes, writable, replacementName, outputFormats }
```

Input is limited to nonempty `.deckcraft` or `.pptx` bytes, bounded by both the descriptor and a **64 MiB** hard ceiling. The Rust parser checks filename/actual format identity and rejects its known missing/damaged-media/slide reports. This is **not** a decompression-bomb or complete parser-resource audit, nor a lossless PPTX guarantee. A ready editor is not an opened document: `deckcraft:opened` is emitted only after successful Rust parsing, with the same `openId` and bound document UID. Open errors are explicit `deckcraft:error` packets; another successful open needs a fresh attachment so unsaved state is not overwritten.

The child sends `{ type: "deckcraft:save", protocol: 1, version, openId, saveId, name, bytes, saveAs }`. The owner calls the **existing** `EditorBackendPort.save({ sessionId, expectedRevision, output }, { signal })` operation through the SDK, rather than reconstructing backend authorization/upload/save workflows in UI. It then replies with:

```ts
{ type: "deckcraft:save-result", protocol: 1, version, saveId,
  status: "saved", revision }
// or status: "conflict" | "read-only" | "access-ended" | "failed", plus message
```

Only a matching exact-origin/source/version/saveId acknowledgement can release the retained serialized snapshot. The Rust bridge marks the **captured Arc snapshot** saved, not whatever document happens to be active or a newer edit. Exports never mark the editable document saved. `deckcraft:saved { saveId, dirty }` confirms application of the acknowledgement. A failed post retains independent bytes and can resend the same stable ID. Conflict/failure retains recovery bytes; another save cannot overwrite an outstanding snapshot. The initial implementation allows one bounded pending snapshot, not an unbounded queue. A successful `postMessage`, child clean notification, local download or synthetic test acknowledgement is never proof of durable cloud persistence.

**SDK contract checkpoint is now implemented by the parent owner; real integration remains a separate gate.** Public exports, DeckCraft admission and correlated protocol decoding are present in the current SDK source. The parent reports 90 passing SDK tests plus boundary and packed three-artifact consumer checks, covering exact version/protocol 1/openId/ordered saveId and opened/save-result/saved interpretation. This content slice did not modify SDK code or independently rerun that owner's full checkpoint. Vendor patch/build bytes are unchanged.

Remaining integration acceptance belongs to the backend/SDK owner:

1. Exercise the public SDK with the **actual** separately versioned WASM and real authorized backend storage, not private imports, editor relabelling or a fixture-only persistence claim.
2. Verify actual open-byte retention until the parsed acknowledgement and correlated save completion across the iframe boundary.
3. Verify deduplication/resends, revision capture, dirty epochs, recovery and save-as/export policy against real backend results. Retries/conflict reconciliation stay SDK/backend-owned.
4. Preserve exact captured origin/window identity and dispose-before-navigation ownership. Do not replay open into an attached editor or reinterpret transport delivery as persistence.
5. Exercise conflicts, newer edits, read-only/revocation, Save As, exports, teardown/reload and recovery through the real lifecycle. The existing synthetic native fixture and new content audit do not establish that integration.

### Protected-mark/UI handoff (no replacement performed here)

The pinned `docs/brand/LICENSE-brand.txt:30-36` requires removal/replacement of ArtCraft marks from distributed modified builds and permits plain-text upstream attribution. **Do not distribute the current experimental artifact.** The UI/brand owner should use these exact source hooks, not globally delete attribution strings:

- `apps/deckcraft-web/index.html:8`: Trunk favicon input `../../assets/app-icon/deckcraft.ico`.
- `crates/ui-egui/src/lib.rs:13`: embedded app-icon PNG from `assets/app-icon/hicolor/128x128/apps/ai.storyteller.deckcraft.png`.
- `crates/ui-egui/src/dialogs/about.rs:53-66`: code-drawn `paint_logo`; called by About (`:22`), `backstage/files.rs:212`, and `backstage/info.rs:222`; re-exported by `dialogs.rs:228`.
- `assets/app-icon/` and `docs/brand/`: source artwork/mark inventory, not permission to recolor/reuse protected marks.
- `dialogs/about.rs:23-50`: displayed product/version identity and upstream links need modified-build presentation review. Preserve the plain-text copyright/licence attribution at `:33`, NOTICE, ATTRIBUTION.md and third-party legal material.

No UI redesign, logo generation or mark replacement was performed. Opus owns the UI/mark changes; any new product image assets must follow the repository's Codex CLI workflow. The next build must hash and test those changes rather than reuse this build's artifact correspondence claim.

## Remaining integration work

- Finish production dependency/feature closure and notice evidence before approving the acquired assets for self-hosted runtime use. Preserve the acquisition safety and legal-byte invariants above.
- Own protocol interpretation and save sequencing in a vanilla SDK/library adapter, with browser subscriptions in an explicitly registered host adapter. A generic DS iframe must remain protocol-neutral.
- Open only currently authorized files; validate saves, current role, quota and revocation through the backend. Bind editor sessions to the intended document and iframe.
- Implement locking or an explicit optimistic concurrency contract from the revision originally opened. Current multipart replacement checks the revision at upload begin, which is not by itself a complete stale-editor-save policy.
- Test open/edit/save/reopen, Save As, exports, cancellation, failed persistence, competing editors, role downgrade and share expiry/revocation using actual browser artifacts.
- Adopt and complete the separately owned modified DeckCraft bridge through the public SDK/backend, including its acknowledgement contract and deployment gates. Do not substitute another editor or call manual download/re-upload a completed integration.

## Native autosave/theme investigation and source-only work — 2026-11-05

This checkpoint supersedes the earlier build-stage ownership/next-step prose above, not its retained evidence. The current all-four static bundle remains `runtime-all4-v2`, manifest SHA-256 `bb6d2eb3f4e81976429c4e0c65de57452898398dd962af7e81083478daa28ea0`, with unchanged official Word/Grid/PDF and separately built Deck `0.14.1-hyori-host.2`. None of these payloads, authorities, source receipts or notice files was overwritten. Future native protocol/theme work is a new modified distribution, not an in-place upgrade of those bytes. Current permission/notices composition is recorded in `tooling/artcraft/runtime-all4-v2.json`; historical false full-audit/product flags are not blanket redistribution blockers.

### Actual capability result

The four top-level wasm-bindgen JS modules export initialization only (`initSync`/default), not an exposed native save/theme handle. The official Word/Grid/PDF host listeners accept `open` only; `ready` means listening, not parsed. Their dirty messages contain boolean transitions, not per-edit revisions. Their native clean transitions happen after successful postMessage, before backend durability. Deck .2 has a real correlated parsed-open acknowledgement and captured-snapshot save acknowledgement, but no incoming serialize/theme command; its dirty events do not carry document/revision identity.

`scripts/artcraft/engine-capability-probe.ts` independently verifies the bb6 runtime first, serves only loopback synthetic documents and current artifacts, runs sandboxed Chromium, and retains actual native save-message digests. Evidence is in `tooling/artcraft/capabilities-v1/browser/`. All four engines produced a native save from an **untrusted** Ctrl+S dispatched to the canvas while that editor already had focus. With focus in the parent, the same dispatch produced **no save** for any engine. Window/document dispatch also produced no save. Every dispatch preserved focus; no fake focus/blur event was used. Trusted user-key positive controls passed all four, without page errors. This is one Chromium/synthetic-input prototype, not cross-browser or cloud durability acceptance.

**Synthetic keys are not the background-autosave implementation.** No focus-stealing adapter is shipped. Existing versions remain manual-save capable; new functionality must be capability-negotiated.

### Native source interface and current gates

The exact per-engine entrypoints and protocol agreement are recorded in `tooling/artcraft/capabilities-v1/native-interface.md`. Committed model identity/revision sources are Word `Session::document_id()/rev()`, Grid `DocState.uid/revision`, PDF `Document.id/edit_generation()`, and Deck `DocState.uid/revision`. Cross JS as opaque decimal strings, never JS u64 numbers or backend file versions. Observe every native revision change even while dirty remains true. Native UI drafts/composition are separately guarded: a model revision does not prove that no newer uncommitted field text exists.

Source-only work now includes:

- `native-methods-patch.ts` plus `patches/native-host-v3/*-native.rs` and `native-types.rs`: direct native parse/serialize/exact-ack/theme methods. They do not re-enter intercepted File Save, clear on postMessage, change source paths for SaveCopy, or overwrite a newer PDF COS graph on delayed acknowledgement. Unsafe live Grid/PDF editors/composition currently return `busy`, rather than consuming the editor or moving focus. This conservative limit is not a claim of complete Google-Office-like draft autosave.
- `native-palette.ts` and `native-chrome-patch.ts`: derive native Rust UI colors from the actual canonical shared CSS Oklch tokens, then patch the real native `Tokens` constructors. Document fonts, model files, page/worksheet content and content-selection/font setup bytes remain untouched. Rendered native contrast, remaining hard-coded control colors and Light/Dark/System acceptance are still required; source tests alone do not establish visual completion.
- `patches/native-host-v3/host-protocol.ts`: a source-only transport state-machine draft with immutable in-flight native snapshots, tuple-correlated durable acknowledgements, stable local error codes and explicit copy names. Its temporary local wire schemas are being handed to the parent-owned public SDK `./editor-runtime` contract; the producer must import that single canonical owner before freeze rather than retain a parallel TS wire definition.

These methods are **not yet connected to new compiled web engines**. Native frame hookup, native Save intent interception, pending-input fidelity, official-three modified marks, exact new source identities, canonical SDK imports, Rust compilation and actual new-WASM acceptance block source freeze/build. No new four-engine build or deployment has been started.

### Load-cost evidence and transport

`tooling/artcraft/capabilities-v1/load-cost.json` records pinned raw/code/data/custom-section sizes, structurally recognized embedded sfnt regions, and gzip-level6/Brotli-quality6 byte experiments. It is **not** a load-time benchmark or production HTTP result. All four current WASM members have only 248 custom-section payload bytes (`producers` and `target_features`), with no observed debug/name section to justify a material strip win. The checked source profiles already use release optimization/thin LTO and Trunk `wasm-opt=z`; opt-level/codegen/LTO variants must be measured, not called faster or speculatively rebuilt.

The generated loader already uses `WebAssembly.instantiateStreaming` when the WASM MIME type is correct. Its initialized `wasm` cache is local to each iframe/module realm: retaining an iframe avoids reinitialization but retains native state/memory; browser compiled-code-cache reuse across reloads is implementation-dependent. The initializer can accept a compiled `WebAssembly.Module`, making an explicit app-owned compiled-module cache/bootstrap a possible later measured optimization, not evidence that native instances, font atlases or parsed documents are shared. Every new instance still performs native startup, font setup and document parse/layout. Font removal/replacement is not part of this patch.

A new manifest-version2 rolling catalogue/transport proposal is in `tooling/artcraft/capabilities-v1/transport-and-rolling.md`. `transport-sidecars.ts` implements deterministic precompressed gzip metadata and independent bounded single-member decode/hash binding. Encoded bytes belong in the **new global** manifest inventory, never original editor payload identities. It rejects appended empty members/trailing bytes as well as tampering, wrong original binding, CRC/ISIZE errors and oversize decode. No sidecar was added to bb6. Backend owns strict verification/catalogue authorization; parent owns actual HTTP negotiation and measurement.

The agreed SDK scheduling policy is 750ms idle / 5s maximum dirty wait, one native serialization and one persistence operation in flight, manual flush immediate, failures/conflicts paused. Those are scheduling requirements, not measured latency claims. Browser/device/deployment conditions and representative document sizes must be agreed before end-to-end performance pass/fail claims; measure cold/warm download, decode/compile/start, fonts, parsed-open, first usable paint and native save pause separately.

### Verification separation

Current source-stage checkpoint: 26 focused tests / 9,062 assertions pass using all four pinned source archives; script TypeScript and root anti-slop pass. This does not compile the new Rust helpers or prove their runtime wiring. React Doctor was run separately with remote scoring/dependency upload disabled: exit 0, five warnings (file-browser complexity, item-collection flushSync, three adjusted-state warnings in use-virtual-windows). No React file was edited by this owner, and those diagnostics are not native engine acceptance.

## Native host v3 build — 2026-11-06

All four editors now have a modified native build that speaks the correlated host protocol 2 (`hyori-correlated-host-v2`): Word `0.14.0-hyori-host.1`, Grid `0.15.0-hyori-host.1`, PDF `0.17.0-hyori-host.1` and Deck `0.14.1-hyori-host.3`. They carry the shared Hyori palette in Light and Dark, follow System live, autosave through the SDK, and drop upstream marks (Discord, Zotero, upstream site links, upstream icons; product names read Hyori Documents/Spreadsheets/PDF/Presentations). Pinned archives, `runtime-all4-v2`, `runtime-all4-transport-v2` and their receipts are untouched; the server still accepts their versions.

### Composition and build

```sh
# Compose, stage, build offline and collect evidence, per app (APP = wordcraft|gridcraft|pdfcraft|deckcraft).
bun scripts/artcraft/native-v3-build.ts APP /new/stage /public-cargo-home /pinned-tools /verified/APP-source.tar.gz
# Run stage/driver/driver.js in the restricted container, or natively at the same absolute paths
# with an empty environment (env -i … /tools/bin/bun --no-env-file --no-install driver.js APP).
bun scripts/artcraft/native-v3-build-evidence.ts /stage-root /new/evidence/APP /pinned-tools /verified/APP-source.tar.gz
# Record the compiled-in authority and per-app receipts, then assemble and check the bundle.
bun scripts/artcraft/native-v3-runtime.ts record /evidence-root
bun scripts/artcraft/native-v3-runtime.ts assemble tooling/artcraft/.generated/runtime-all4-native-v3 \
  tooling/artcraft/.generated/runtime-all4-v2 /evidence-root
bun scripts/artcraft/native-v3-runtime.ts check tooling/artcraft/.generated/runtime-all4-native-v3 MANIFEST_SHA256
```

`native-v3-source.ts` composes each app in recorded stages: Deck's .2 host-engine base (Deck only), direct native methods, intents/jobs, app frame hookup, the shared frame, palette, then `native-v3-marks.ts`. The host entry is bundled from `patches/native-host-v3/host-entry.ts`, which imports its wire types from `@hyori-cloud/client-sdk/editor-runtime`; the bundled effect/@effect/rpc licences ship with it. Cargo.toml files, Cargo.lock and the original legal files are byte-for-byte unchanged. Builds ran Cargo `--locked --offline` and Trunk `--locked=true --offline=true` with the deckcraft-host-v1 tool pins. Docker was unavailable on the build host, so the container step ran natively against root-owned read-only inputs at the container's absolute paths with an empty environment; that is weaker isolation than the container and is recorded as such.

Each bundle app ships `legal/native-host-v3/<app>/` with `MODIFICATIONS.md`, the complete modified source and the original legal files. Records: `tooling/artcraft/builds/native-host-v3/<app>/{receipt,build-manifest,source-summary}.json`, the compiled-in authority `tooling/artcraft/runtime-native-v3.json`, and the bundle handoff `tooling/artcraft/runtime-all4-native-v3.json`. Trunk prints its content hash unpadded (Word's is 15 digits), so the v3 assembler matches 1–16 hex digits for the top-level pair and keeps them immutable-cached.

### Fixes found in the browser

- A plain Save pressed while a save was in flight returned `busy` from the shared intent sink, which Grid showed as an alert. The sink now refuses only a second queued intent, or an explicit export while a save is pending; the host coalesces or cancels a plain replacement.
- Deck's theme hook called a nonexistent `view.darkMode`; it is `view.dark`.
- The SDK could leave the bar at "Saving soon…" indefinitely after a save had landed. Deck reports a dirty burst while the capture is out; the capture covers it, but the autosave timer it started (or a flush queued during persistence) then refused to save nothing new without republishing the snapshot. The timer callback and `drain` now publish when they find nothing to save; both cases are covered in `packages/client-sdk/tests/editor-autosave.test.ts`. Seen in 3 of 5 Deck attempts before the fix.
- Saving a copy leaves the source session's own edits unsaved (the copy holds them), so closing a converted PPTX after its copy asks before discarding.
- A protocol 2 editor knows a converted file (PPTX in Deck) is copy-only when it opens: it reads "Save a copy to keep changes" and offers Save a copy, rather than failing a first save.

Browser scenarios branch on the protocol the bundle declares, never on hard-coded versions. Native editors may make more than one version per edit session (background save plus Ctrl+S); the checks count versions against server-confirmed saves.

## Native host v3 revision r2: rebuilt from pinned public inputs — 2026-11-07

Every bundle and every intermediate from earlier builds lived only in a now-unreachable orb's gitignored `tooling/artcraft/.generated/`. That covers r1 (`runtime-all4-native-v3`, manifest `5697833f…26db`), the `runtime-all4-v2` base (`bb6d2eb3…a28ea0`), the notice-adoption and Deck .2 inputs, and the native staging. Nothing could be copied. r2 was rebuilt on runner Hyorinmaru from committed sources and hash-pinned public downloads only.

### Why r1 can't be reproduced and r2 has new pins

- **r1's build manifests can't be rebuilt.** `build-manifest.json` hashes each command's `elapsedMs`, stdout and stderr. Its SHA-256 therefore changes on every build, and so do the receipt and authority pins that depend on it. The payload is a separate question. A fresh Grid build at HEAD reproduced r1's `payloadSha256` `69076e11…0687` and WASM `4953dd49…795f` bit for bit, but its build manifest is necessarily new. r1's committed records stay as they are, and the server still accepts r1 bundles.
- **HEAD composes different Word and Deck sources.** The polish commits d3f2e77/d65079c renamed them `0.14.0-hyori-host.2` and `0.14.1-hyori-host.4` in `nativeArtifactVersions`. Grid and PDF compose byte-identical sources to r1.
- **PDF reproduced its bytes but not its file names.** The rebuilt PDF WASM (`228d09b9…`) and JS (`13162cd8…`) match r1 exactly, but Trunk named them `pdfcraft-web-4d57fe7f91d1a19*` instead of r1's `pdfcraft-web-3b534dae8bf1cea2*`, and `index.html` changed with them. Trunk derives that hash from its pre-optimisation input, so a likely cause is nondeterminism in the intermediate cargo WASM. r1's intermediate no longer exists, so that remains unconfirmed. A payload that differs needs a new version, so a HEAD-only build would have made PDF `0.17.0-hyori-host.2`. Grid reproduced r1's whole payload, so a HEAD-only Grid could have kept `0.15.0-hyori-host.1`.
- **r2 also carries the frame fixes.** Those are the `discarded` save result with its `takeDiscard` fence, `themeFailed`, the http/https/mailto allow-list for egui `OpenUrl`, and `takeOpen` no longer copying the document. They change `host-protocol.ts`, `host-entry.ts`, `native-frame.rs`, `native-imports.rs` and the bundled SDK `native-runtime.ts`. The wire protocol is still 2, with additions only. Every app's payload changes, so no HEAD-only revision was recorded. r2's versions are Word `0.14.0-hyori-host.3`, Grid `0.15.0-hyori-host.2`, PDF `0.17.0-hyori-host.2` and Deck `0.14.1-hyori-host.5`.
- **A version names exactly one payload.** `record` now refuses an app whose version an earlier authority already pins to a different payload. Any changed payload has to bump `nativeArtifactVersions`.

### The base chain reproduced its committed pins

`content-acquire.ts` acquired the four pinned official ZIPs, then `content-runtime.ts assemble` composed the official-three bundle. Its manifest SHA-256 reproduced `1bfd3449…e8fc` (`runtime-official3-v1`). Deck .2 was rebuilt with `deckcraft-build.ts --marks` in the pinned restricted container and reproduced WASM `81ecb8a3…ef98`, JS `c586cf23…`, host bridge `cbaf952f…` and index `09791017…`. Its build inputs differ from the committed plan only in the Cargo cache's Git pack files and sparse-index cache entries. Every `cargo fetch` writes those files afresh, but the locked commits and crate checksums stay the same. The all-four composition then passed `content-runtime.ts check` against the original **`bb6d2eb3…a28ea0`** pin. The legal base is therefore the same bytes r1 used; no new pin was needed.

### Isolation

r1 ran natively without network isolation. r2 runs each editor in `scripts/artcraft/native-v3-container.ts`, one container at a time. Each one uses the pinned `rust@sha256:be499482…` image with `--network none`, an unprivileged UID, a read-only root, `--cap-drop ALL`, `no-new-privileges`, and limits of 6 GB memory and no swap, 6 CPUs and 512 PIDs. Input, driver and tools are mounted read-only at the driver's absolute paths. The exact command and exit status are retained in each app's evidence (`container-command.json`, `container-result.json`), and `execution` in the build manifest says which isolation ran.

### One rebuild command

```sh
# Bun 1.4.4 and Docker. Downloads pinned inputs, rebuilds the bb6 base, builds all four editors,
# records the current revision's authority/receipts, assembles and checks the bundle.
~/.bun/bin/bun scripts/artcraft/native-v3-rebuild.ts [WORK_DIR]
```

Each step is skipped when its result exists, and a failed step's partial output is removed before it reruns. Before changing patches or pins, measure how far upstream has moved (see [Upstream drift](#upstream-drift-and-the-upgrade-path--2026-11-12)). For the next revision, after patches change:

1. Append a revision to `revisions` in `native-v3-runtime.ts`, with a new authority, receipt root, bundle and handoff name.
2. Commit the new `tooling/artcraft/runtime-native-v3-rN.json` authority alongside its receipts, leaving earlier revisions unchanged. The server build discovers these files automatically; no Rust constant edit is needed.
3. Bump `nativeArtifactVersions` for every app whose payload changes.
4. Run the command above with a fresh `WORK_DIR`, or delete the native `stage/*` and `evidence/*` directories in the old one. The downloads, tools, Cargo cache and bb6 base are reused.

### Server acceptance

`editor_assets.rs` compiles in every authority revision. A bundle's `legal/native-host-v3/authority.json` must hash-match exactly one of them. That revision alone then pins the editor's version, source, build manifest, payload, WASM, receipt and source summary. An editor from one revision is not accepted against another revision's carried authority or receipts. The full inventory, mode, sidecar and unregistered-payload checks are unchanged. `editor_protocol` derives protocol 2 versions from the compiled-in authorities instead of a hard-coded list. The browser scenarios read the accepted native versions from the same committed files.

### CSP for the inline loader

Trunk's `index.html` starts the engine from one inline `<script type="module">`. Its text names that build's hashed JS and WASM files, so it differs per app and per build. Rather than rewrite Trunk's output, which would add a post-build transform and change payload bytes after Trunk's SRI attributes were computed, `native-v3-build-evidence.ts` records the loader's CSP hash. It refuses an entry with anything other than exactly one inline script. The hash appears as `cspScriptHashes` in each r2 receipt and in the handoff's `editors[]`. A gateway can then send `script-src 'self' 'wasm-unsafe-eval' 'sha256-…'` for each app's `/artcraft/<app>/<version>/` path, or one policy listing all four hashes. The entry also has an inline `<style>`, so `style-src` would need its own hash or `'unsafe-inline'`; that is not recorded here.

### r2 results (2026-11-07, runner Hyorinmaru)

- Bundle `tooling/artcraft/.generated/runtime-all4-native-v3-r2`, manifest SHA-256 **`8c8998f74a6d11b4ebc84f70f70adb284b9e1bed6ea3f6c9b26e99030e5ab4a4`**, 4,123 files. `native-v3-runtime.ts check` passes and regenerates the committed handoff byte for byte.
- WASM: Word `c0708fdd…4d18`, Grid `6fdc25f0…274e`, PDF `51d6d2b2…79ab`, Deck `f10d5f65…f594`.
- `bun run check:rust` passes. `bun run test:rust-services` passes with `HYORI_EDITOR_TEST_BUNDLE_DIR`/`SHA256` set to this bundle: 64 tests. The actual-bundle activation test now reads its expectations from the bundle manifest; it used to hard-code the official-three bundle, so it failed for every all-four bundle. On this runner `/tmp` is a small tmpfs, so set `TMPDIR` to a short on-disk path. A long path overflows the media worker's Unix socket limit.
- `scripts/test-rust-browser.ts` editors scenarios, with the server image built from this branch and `hyori-media-worker:local`: 114 passed, 0 failed, 12 unverified. Ten of the unverified items were reopened-document screenshots, and a person read all ten as correct. The other two are documented behaviour: repeat PPTX saves ask each time, and the read-only Save As Browse… control can't be located automatically.
- `scripts/dev-stack.ts` now defaults to `runtime-all4-native-v3-r2.json`.

## Upstream drift and the upgrade path — 2026-11-12

### Drift check

```sh
# Network: git ls-remote and codeload archives only. Nothing upstream is executed.
bun scripts/artcraft/native-v3-drift.ts [--cache DIR] [--json FILE] [--target APP=vX.Y.Z]... [--fail-on-drift]
```

For each editor it checks that the pinned tag still points at the pinned commit and still composes, then composes the fork on the newest upstream tag (or `--target`), and three-way merges every upstream file the fork edits (base: pinned tag, ours: composed fork, theirs: target). It reports the composer's first failure, conflicting files, hunks and lines, and the fork's size per composition stage. Exit 1 means a pin broke; with `--fail-on-drift`, exit 2 means the target does not apply cleanly. Textual success is not a build: authored Rust modules can still fail to compile against a newer upstream API.

Results on 2026-11-12 (pins: Word 0.14.0, Grid 0.15.0, PDF 0.17.0, Deck 0.14.1, all released 2026-11-01; upstream ships every two to three days):

| Editor | Newest tag (releases since pin) | Fork: upstream files edited + files added | Changed lines: host protocol / theming, branding, polish | Last tag the composer applies to | Three-way conflicts on newest tag                                                    |
| ------ | ------------------------------- | ----------------------------------------- | -------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------ |
| Word   | v0.18.1 (7)                     | 20 + 7                                    | 1,041 / 208                                              | v0.15.0                          | 6 files, 7 hunks, 322 lines                                                          |
| Grid   | v0.19.1 (6)                     | 21 + 7                                    | 1,132 / 141                                              | none                             | 2 files, 4 hunks, 34 lines                                                           |
| PDF    | v0.21.1 (7)                     | 15 + 7                                    | 1,250 / 159                                              | none                             | 4 files, 7 hunks, 166 lines                                                          |
| Deck   | v0.18.1 (6)                     | 22 + 9                                    | 7,352 / 195                                              | none                             | 5 files, 8 hunks, 132 lines; upstream added its own `apps/deckcraft-web/src/host.rs` |

- Grid v0.16.0 and PDF v0.18.0–v0.18.2 merge without a single textual conflict, yet the composer refuses them. `grid-native-hookup.ts` and `pdf-native-hookup.ts` pin the SHA-256 of 11 and 6 whole upstream files, so any upstream edit anywhere in those files stops the build until someone re-pins by hand.
- Deck's 6,329-line `deck-host-engine-base` stage, mostly the frozen protocol-1 `host-bridge.js.source`, is the largest and most conflict-prone part of the fork. The r2 payload does not ship that JavaScript.
- Upstream's toolchain has not moved: the newest tags still declare `rust-version = "1.95"` and lock wasm-bindgen 0.2.129, matching `tool-pins.json`.

### Upstream now has a host contract

Since the pins, all four upstream web builds use `craft-web-host` (storytold/craft-libs `crates/web-host`, rev `fd5e2fef…` in the newest tags), described as one contract "for pages that embed DeckCraft and keep its files (a Nextcloud app, a personal file server)". Its version 1 has `ready`, `open`, `save` with an optional `id`, a host `saved {id}` acknowledgement that clears dirty, `dirty`, `failed` and `handoff`. Upstream `craft-web-api` adds `window.<app>.execute`, including `ui.theme`. Protocol 2 still needs pieces upstream lacks: host-initiated `request-save` for autosave, a parsed `opened` acknowledgement, opaque document revisions on `dirty`, correlated error codes and `cancel-intent`. Rebasing onto `craft-web-host` and proposing those additions upstream would turn most of the host-protocol stage into upstream code.

### Server rebuilds and authority trust

Every new authority still needs a server image rebuild. `apps/server/build.rs` discovers `tooling/artcraft/runtime-native-v3*.json` in the build source, orders the unsuffixed r1 then numeric revisions, and fails if none exist. The server Dockerfile copies the same wildcard files into the builder. No Git checkout is required inside the image build, and no runtime operator-supplied authority is trusted. A build elsewhere still cannot reuse an authority because `build-manifest.json` hashes command timings and logs.

Protocol-2 acceptance uses the source archive pinned by the exact committed authority carried in the bundle, not the composer's current `sourceSha256` in `manifest.json`. Raising the current upstream pin therefore preserves earlier authorities' bundles, while a source hash absent from that authority is refused. The upgrade regression tests both outcomes for every committed authority. The official/legacy protocol acceptance rules are unchanged.

The generated list preserves the committed-source trust rule. Alternatives that would remove the image rebuild remain unapproved proposals for aarsh:

1. **Signed authorities (same provenance, no rebuild).** Compile in one Ed25519 public key; a bundle carries an authority signed with the offline key. Any machine can build, and the server accepts it if the signature verifies. Trade-off: the private key becomes the root of trust and needs rotation and revocation, and the server gains a signature dependency.
2. **Operator pin only (no rebuild, weaker provenance).** Accept any bundle whose manifest matches `HYORI_EDITOR_ASSETS_MANIFEST_SHA256`, still running the full inventory checks. Trade-off: anyone who can change deployment configuration and the mounted directory can run arbitrary same-origin code with users' full account privileges. The compiled-in list exists to prevent that.

Independently, excluding `elapsedMs`, stdout and stderr from the hashed build manifest, with the logs kept beside it, would let a rebuild elsewhere reproduce an authority whenever the payload is reproducible. Grid r2 reproduced r1's payload bit for bit.

### The frame bridge's dependency boundary

The earlier cross-machine nondeterminism hypothesis was incorrect. At `6b08373`, Bun 1.4.4 builds the bridge as 219,942 bytes with SHA-256 `bdfaa8e114dfccabce6343065ef2842ea7a8c83fa26d03e99df7baf362b51849`. The runtime codec imported `EditorName` from `editor-contract.ts`, which imported the product RPC barrel; initializing that barrel pulled the unrelated generated operation catalog into the frame. The frame never calls those operations. That dependency, rather than a host-protocol change, made later API additions change the bridge relative to r2.

`native-runtime.ts` now owns the leaf filename codec and `editor-contract.ts` re-exports it. Protocol 2's existing filename constraints, discriminants, bytes, opaque revisions and message shapes stay unchanged. The product descriptors remain Rust-owned; no product RPC schema is hand-copied into the frame.

`bun test scripts/artcraft/native-host-entry.test.ts` builds the browser bridge twice, changing an unrelated admin RPC name in the bundler's catalog input for the second build, without rewriting generated files. The regression failed before isolation (`bdfaa8e1…1849` versus `2ac346d0…366a`) and passes after it (both `0cd1cd7fadcef5c2a0968fc7b749614b85f9b21e1954158ee4ad555a96f7d2ba`). This builds only the authored JavaScript entry in memory, not an editor bundle. A new editor bundle revision is still required to ship the changed bridge; the committed r1/r2 authorities and receipts are not rewritten.
