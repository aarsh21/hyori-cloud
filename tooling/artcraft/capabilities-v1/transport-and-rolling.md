# New runtime transport and rolling-catalogue contract

This is a schema/composition handoff for a NEW runtime root and NEW global manifest. The shipping bb6 root, original files, `.2` payload hash and existing receipt authorities remain immutable. No sidecars are added there.

## Catalogue proposal agreed with the backend owner

- New global manifest schema version 2, at most eight editor descriptors: exactly one `role:"current"` and at most one `role:"legacy"` per app. Existing version-1 manifests omit role and retain their current interpretation; do not rewrite them.
- Current/legacy descriptors identify exact app + artifact version + protocol + original payload identity. Opening a new editor selects current. An existing session resolves its exact pinned version, including legacy, rather than whichever version the database currently selects. App-level disablement/revocation still denies both.
- New four use `bridge:"hyori-correlated-host-v2"` and explicit `protocol:2`. Old descriptors retain their original bridge identities. Protocol selection is metadata, not an app-name guess or reconstructed URL; the backend's exact `assetUrl` remains authoritative.
- New modified builds reserve distinct source-only identities: Word `0.14.0-hyori-host.1`, Grid `0.15.0-hyori-host.1`, PDF `0.17.0-hyori-host.1`, Deck `0.14.1-hyori-host.3`. No hash/pin is invented before build collection. Proposed `runtime-native-v3.json` authority will enumerate independent app/version source archive, build manifest, canonical original payload, receipt and source-summary hashes and local witness paths. Parent/backend own the final authority parser contract.
- Preserve every old URL and its exact bytes until corresponding session close/expiry. Retention is not a bypass of current role/share/app authorization. Never garbage-collect an old editor merely because it is no longer the default.
- Shared notice files may be deduplicated only when both path and exact bytes/hash agree. Version-specific modified source and legal receipts use separate namespaces. Enforce the final global limits (512 MiB, 10,000 files, 8 MiB manifest) AFTER combining raw payloads, notices, modified source evidence and encoded sidecars. No claim that a not-yet-built eight-editor composition fits is made.

## Exact gzip sidecar schema

`scripts/artcraft/transport-sidecars.ts` owns the producer-side schema and deterministic encoder/checker:

```ts
transportSidecars: Array<{
  path: string; // exactly original.path + ".gz"
  bytes: number; // encoded bytes, > 0 and <= 128 MiB
  sha256: string; // encoded SHA-256
  encoding: "gzip";
  original: {
    path: string; // independently verified original editor.files WASM or JS member
    bytes: number; // exact decoded size, <= 128 MiB
    sha256: string; // original payload member SHA-256
  };
  encoder: "gzip-level6-mtime0-os255-v1";
}>;
```

Every encoded member ALSO has its encoded byte count/hash in the global `assets` inventory and is included in the global manifest's externally pinned hash. The mapping cannot silently bless an extra file, remove raw files or weaken original identity. Reject duplicate mappings, path collisions, any mapping to a legal/unlisted/foreign member, and unknown encoded files. Sidecars are **not** included in `editor.files` or any canonical original payload hash. Raw paths/bytes/receipts remain unchanged.

The encoder uses gzip level 6, fixed header `1f 8b 08 00 00 00 00 00 00 ff` (no optional fields, mtime zero, XFL zero, OS 255), one deflate stream, CRC32 and ISIZE. Repeated encoding under the pinned tool environment is deterministic; the exact encoded digest pins the result rather than assuming all future deflate implementations emit identical bytes.

The checker bounds the compressed input, verifies its independent encoded hash, decodes ONE raw deflate stream with `maxOutputLength` bounded to the independent original size (one-byte bound for an empty original), verifies the exact stream end/trailer position, CRC32, ISIZE, decoded size AND SHA-256. Concatenated members—including an appended empty member whose decoded hash would otherwise still match—and all trailing bytes are rejected. Rust backend verification should implement the same strict single-member/consumption checks with bounded streaming and must not trust a sidecar's own source claim as the independent original.

### Serving

Select encoded bytes only for the same original URL when `Accept-Encoding` permits gzip; send the original MIME type, `Content-Encoding:gzip`, correct encoded `Content-Length`, `Vary:Accept-Encoding`, nosniff, and original immutable/no-cache policy. HEAD must describe the selected representation. ETag/range handling must refer to that encoded representation, not raw byte offsets; production serving acceptance must explicitly cover identity/gzip GET, HEAD, revalidation and range behavior. Never dynamically gzip an existing `.gz` a second time. Physical `.gz` records may use `application/gzip` in the inventory; URL negotiation must use the original member's MIME type. The parent owns Caddy integration; the backend owner owns Rust validation/dependency decisions.

Precompression moves compression off the request path; it does not remove client download, decompression, WASM compilation, native initialization, font installation or document parse/layout costs. Parent's preliminary loopback identity/gzip measurements are separate HTTP evidence, not a measured end-to-end editor load budget.
