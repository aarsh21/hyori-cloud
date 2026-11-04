# ArtCraft browser integration findings

Reviewed 2026-11-04. All four editors remain approved v1 requirements. They are not integrated into Hyori Cloud yet; an iframe launcher alone is not cloud document editing.

## Verified upstream contracts

| App       | Released browser package                                              | Host-storage bridge in tagged source                                                                                                                                                |
| --------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WordCraft | [0.14.0](https://github.com/storytold/wordcraft/releases/tag/v0.14.0) | [host.rs](https://github.com/storytold/wordcraft/blob/v0.14.0/apps/wordcraft-web/src/host.rs)                                                                                       |
| GridCraft | [0.15.0](https://github.com/storytold/gridcraft/releases/tag/v0.15.0) | [host.rs](https://github.com/storytold/gridcraft/blob/v0.15.0/apps/gridcraft-web/src/host.rs)                                                                                       |
| DeckCraft | [0.14.1](https://github.com/storytold/deckcraft/releases/tag/v0.14.1) | No corresponding bridge established; [browser entry point](https://github.com/storytold/deckcraft/blob/main/apps/deckcraft-web/src/main.rs) describes local file pickers/downloads. |
| PdfCraft  | [0.17.0](https://github.com/storytold/pdfcraft/releases/tag/v0.17.0)  | [inline host module](https://github.com/storytold/pdfcraft/blob/v0.17.0/apps/pdfcraft-web/src/main.rs)                                                                              |

The release metadata and tagged source were read, not executed. Browser artifacts have not been installed or exercised. License notices, artifact checksums, browser format fidelity, and actual WASM execution remain to be validated per selected version.

WordCraft's [web hosting guide](https://github.com/storytold/wordcraft/blob/main/packaging/web/README.md) documents static hosting, relative asset paths, `.wasm` MIME types, caching/compression and iframe requirements.

## Message protocol established in source

WordCraft, GridCraft, and PdfCraft support `?host=parent` in a same-origin iframe. Each prefixes its messages with its application name:

- `:ready`: the parent may send a document.
- `:open`: parent sends `{ name, bytes }`, with ArrayBuffer/Uint8Array bytes.
- `:save`: child sends `{ name, bytes }`; WordCraft/PdfCraft also distinguish `saveAs`.
- `:dirty`: child reports unsaved changes.
- `:failed`: child reports startup failure.

The source checks both message origin and sender window. Hyori's future host adapter must do the same. Treat export/Save As separately from replacing the opened cloud file. A child reporting clean does not prove the parent persisted its save; the host must own visible pending/failure/retry behavior and retain unsaved bytes until persistence succeeds.

## Remaining integration work

- Package pinned, checksum-verified assets for self-hosting; preserve upstream licenses. Use a separate empty staging directory for each downloaded archive and validate paths before extraction.
- Own protocol interpretation and save sequencing in a vanilla SDK/library adapter, with browser subscriptions in an explicitly registered host adapter. A generic DS iframe must remain protocol-neutral.
- Open only currently authorized files; validate saves, current role, quota and revocation through the backend. Bind editor sessions to the intended document and iframe.
- Implement locking or an explicit optimistic concurrency contract from the revision originally opened. Current multipart replacement checks the revision at upload begin, which is not by itself a complete stale-editor-save policy.
- Test open/edit/save/reopen, Save As, exports, cancellation, failed persistence, competing editors, role downgrade and share expiry/revocation using actual browser artifacts.
- Establish DeckCraft's host open/save path or add an explicitly owned upstream-compatible adapter. Do not substitute another editor or call manual download/re-upload a completed integration.
