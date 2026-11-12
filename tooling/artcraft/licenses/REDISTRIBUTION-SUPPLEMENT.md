# Hyori ArtCraft redistribution supplement

This document supplements, and does not replace or alter, the retained upstream notices. Acquisition is not deployment approval. The complete production wasm32 dependency/feature closure and notice audit remain open for every editor.

## Shared egui fonts (all four editors)

The retained Cargo.lock files pin `epaint_default_fonts` and egui to storytold/egui commit `6d518fc799681571963842f95b55a6b68431b15a`. Older revision references in upstream attribution are not the lockfile provenance for these releases.

The shared `egui/` bundle retains the exact upstream licence texts and reproduces the font name-table copyright/licence records in `*.ttf.names.json`. These records were extracted from that exact revision; input/output SHA-256 hashes and extraction methods are in `redistribution.json`. No font binaries were added to this repository by this supplement.

- Ubuntu Light: Copyright 2011 Canonical Ltd. Licensed under the Ubuntu Font Licence 1.0. See `shared/egui/UFL.txt` and `shared/egui/Ubuntu-Light.ttf.names.json`.
- Hack: Copyright (c) 2018 Source Foundry Authors / Copyright (c) 2003 by Bitstream, Inc. All Rights Reserved. MIT and Bitstream Vera licences; the DejaVu work was committed to the public domain. See `shared/egui/Hack-Regular.txt` and `shared/egui/Hack-Regular.ttf.names.json`.
- Noto Emoji: Copyright 2013 Google Inc. All Rights Reserved. SIL Open Font License 1.1. See `shared/egui/OFL.txt` and `shared/egui/NotoEmoji-Regular.ttf.names.json`.
- egui-icons.ttf and emoji-icon-font.ttf: Copyright (c) 2014 John Slegers, MIT. The existing upstream icon-font notices remain intact; the exact pinned standalone notice is also in `shared/egui/emoji-icon-font-mit-license.txt`.

GridCraft's original NOTICE already contains the full shared-font licence bodies. It is retained byte-for-byte; the separate font name-table records supply the omitted Ubuntu/Noto copyright headers. This is not evidence that arbitrary optional craft-fonts families were embedded. WordCraft's concrete extra-font requirements checked here are Inter, JetBrains Mono, Source Sans 3, Source Serif 4, and Noto Sans Georgian; their existing retained OFL notices are preserved.

## WordCraft PDF writer and Polish hyphenation

WordCraft 0.14.0's actual lockfile pins craft-pdf and Krilla 0.8.2 to storytold/craft-libs commit `92d392cff132eaf53e13afff77f38b5c11b73aa0`, not the older `b926b5c03e256c86ca10934f58d03f628810b5b7` stated in its upstream NOTICE. The old NOTICE is preserved unchanged. The correct revision's `ATTRIBUTION.md` and `licenses/pdf-writer/` MIT, Apache-2.0, and ICC CC0 texts are retained under `wordcraft/supplement/craft-libs/`. That attribution also describes optional/test material; retaining it does not assert that all such material is in WordCraft's production binary.

The standalone `wordcraft/supplement/hyphenation/pl-header.txt` preserves the complete original comment header of the pinned Polish pattern file, including Copyright (C) 1987-1995 Hanna Kołodziejska, Bogusław Jackowski, Marek Ryćko and the MIT permission/disclaimer. It is not merely a reference to a notice embedded in a WASM binary.

## DeckCraft Symphonia 0.5.5

DeckCraft's lockfile contains sixteen Symphonia 0.5.5 packages declaring **MPL-2.0**. The retained licence and per-source-file leading notices are under `deckcraft/supplement/symphonia/`. The source notice inventories explicitly identify files with no leading copyright/MPL header instead of inventing one. Normalized/original package manifests and `.cargo_vcs_info.json` records are retained as audit evidence.

`SYMPHONIA-SOURCES.md` in the acquired legal bundle lists a direct matching crates.io source archive, exact version, size, and lockfile SHA-256 for each package. `redistribution.json` records the same sources and the immutable upstream VCS revision `6d533f26150953a882a6a111ebd13f0abf7129d5`. These are source references for the locked, unmodified upstream packages, not a claim to have reconstructed the release's exact linked feature closure or a future patched DeckCraft build. If covered files are modified, make the matching modified Source Code Form available too and update the notices/source references before distributing the resulting executable.

Recipients of covered executable code must be informed how to obtain its corresponding Source Code Form under MPL-2.0; the listed public archives provide the currently retained matching-source references. Any deployment must keep those references usable or supply the matching archives itself. MPL-2.0's covered-file obligations do **not** mean that the whole Hyori application must be relicensed under MPL. This supplement is not legal advice or a complete dependency audit.

## PdfCraft Hayro ICC profile

The pinned PdfCraft source's Hayro asset README identifies Compact ICC Profiles and CC0-1.0. Its `CGATS001Compat-v2-micro.icc` is byte-identical (SHA-256 `73e1ba37d2bad5bab2a964f40a9eed96209666efc067c3322626214bbef234a0`) to saucecontrol/Compact-ICC-Profiles commit `bdd84663061bc4ae95ca70decff54f581e27f702`, `profiles/CGATS001Compat-v2-micro.icc`, by Clinton Ingram. The README and full CC0 text are retained under `pdfcraft/supplement/hayro-icc/`; immutable URLs and both profile input hashes are in `redistribution.json`. Existing Foxit/PDFium and Adobe CMap BSD notices remain unchanged.

## Explicit remaining gates

- Exact wasm32 production dependency and enabled-feature closure for all four binaries; complete notices matched to that closure. Root MIT/Apache licences and Cargo-deny alone do not establish this.
- Real browser WASM execution, open/edit/save/reopen and format-fidelity evidence.
- DeckCraft host bridge, reproducible patched build, and removal/replacement of its protected ArtCraft marks before redistribution. No marks have been changed by this slice.

All acquired editors remain `deployable: false`.
