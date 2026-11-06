# Current-engine capability investigation

This directory records a bounded 2026-11-05 source investigation and actual sandboxed Chromium prototype against the unchanged `runtime-all4-v2` bundle. It is not a modified editor distribution, product acceptance, cross-browser proof, or a performance benchmark.

`browser/` is produced by `scripts/artcraft/engine-capability-probe.ts`: synthetic local-only inputs, actual native WASM output messages, untrusted keyboard dispatch with unchanged focus, and a trusted-user-key positive control. Save acknowledgements for Deck are synthetic transport acknowledgements, not cloud durability.

`load-cost.json` records static section/font sizes and explicitly parameterized compression experiments; it does not establish load time or production HTTP encoding. No compressed or stripped editor payload is shipped here.

See `docs/artcraft-integration.md` for exact source entrypoints, constraints, and the proposed new native bridge. Existing shipping assets, `.2` authorities, build receipts and notices must not be overwritten. New bridge/theme support requires new modified identities and a source freeze before any coordinated restricted build.
