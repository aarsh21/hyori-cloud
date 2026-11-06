# Document workspace performance

Status: measurement plan and provisional engineering budgets, not achieved service levels. Native protocol-2 engines, automatic saving, and precompressed transport are being integrated; the running LAN bundle still uses the older manual protocols. No physical-device, general Office-fidelity, or complete-stack capacity claim follows from these checks.

## Workload and environment

Use generated public fixtures only; never profile an existing user's documents or credentials. Retain the fixture generator, exact bytes/hash, engine version, runtime manifest, frontend/backend image IDs, protocol, browser version, and test configuration with each result.

| Workload | Small interaction case                                            | Larger diagnostic case                                                         |
| -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Word     | One-page DOCX with plain paragraphs and a distinctive edit marker | 100-page DOCX with paragraphs, tables, and repeated generated images           |
| Grid     | XLSX with 100 populated cells and one edited cell                 | 10,000 populated cells, formulas, and multiple sheets                          |
| PDF      | Two-page generated PDF with a single ink/text edit                | 100-page generated PDF with embedded text and generated images                 |
| Deck     | Three native slides and a title edit                              | 50 native slides with generated shapes/images; PPTX import measured separately |

These are fixture definitions to implement, not existing benchmark results. Report actual compressed/expanded sizes; padding a ZIP to the upload ceiling is not a representative document. Keep every fixture inside supported engine/format limits. Preserve document fonts and images when optimizing runtime chrome or embedded runtime assets.

The recorded local host is an AMD Ryzen 5 4600H (6 cores/12 threads), with Docker reporting 16,093,499,392 bytes available and 12 logical CPUs. Existing headless editor fixtures use Chromium with SwiftShader software WebGL. This is **not** the approved product's 2-core/4-GB complete-stack baseline. Record concurrent compilation/load, container limits, cache state, power mode, client viewport, and rendering backend. Run the capacity baseline separately with an explicit complete-stack resource envelope, not a 4-GB allowance for each individual service.

Test both HTTP/1.1 and HTTP/2 through the same-origin verified-TLS gateway. A deployment-host request to its own LAN IP measures local delivery, not a physical client network. No human-approved device/network latency targets have been established beyond the product's deployment-class/resource direction; the following budgets guide investigation and must be validated under recorded conditions before becoming product claims.

## Provisional budgets

- Primary document activation: visible opening feedback within 100 ms; no accidental download while availability resolves and no per-row capability RPC.
- Small-document open on a desktop client and uncongested LAN: investigate toward 3 s cold and 1 s warm from activation to parsed, usable content. Include original download, not just editor readiness.
- While typing: no focus/caret/selection interruption; do not hide main-thread stalls behind motion. Record long tasks over 50 ms during open and save.
- Automatic save admission: request a native snapshot after 750 ms idle, with a 5 s maximum wait during continuous committed edits when native capture is safe. An unsafe IME/live draft may defer capture; display pending work honestly rather than claiming a timed durability guarantee.
- Small-document save: investigate toward 250 ms native serialization and 1 s from serialization completion to authoritative durable confirmation on the recorded LAN setup. Measure hashing and transfer separately. Larger cases report observed scaling rather than inheriting the small-file target.
- One native serialization and one persistence operation in flight per attachment. Coalesce later work, bound retained recovery snapshots, and pause on a genuine failed/conflicting save.

Targets are investigation thresholds, not a reason to weaken authentication, conflicts, history, digest validation, or storage durability. A copy/export cannot satisfy the source-save budget by changing the original's saved status.

## Measurement boundaries

Capture timestamps from one monotonic client clock where possible:

1. Primary activation and host feedback.
2. Authorized descriptor resolution and original download start/end.
3. Runtime asset requests: connection/TTFB, encoded/decoded sizes, cache status, and content encoding.
4. Engine initialization and ready event.
5. Correlated open sent and **parsed** `opened` acknowledgement.
6. First usable input confirmed by a subsequent native edit/revision change.
7. Dirty/draft observation, scheduler deadline, request-save, and native immutable snapshot emitted.
8. SDK hashing, prepare request, acknowledged transfer, publication, and authoritative completion response.
9. Native save-result receipt/application and remaining dirty state.

Legacy ready/open-post timestamps are **not parsed-document timings**. The official Word/Grid/PDF protocols have no parsed-open or focus-independent serializer acknowledgement; report those phase measurements as unavailable rather than substituting readiness. A native `saved` event is never the durability clock; the backend completion response owns it. An ambiguous reply remains ambiguous until replay of the exact same save ID and bytes reconciles.

Cold means a fresh browser profile without HTTP/WASM compilation caches. Warm means a fresh attachment in the same browser/profile after a clean close, retaining ordinary caches; do not reuse an already open document and call it a reopen. Use at least five cold and ten warm observations per small workload for investigation, retain all failures/raw observations, and report median/range. Do not claim a reliable tail percentile from that small sample. Separate serialization time from the intentional autosave idle delay.

## Browser cache probe

`scripts/profile-editor-static.ts` records two public-asset fetches in a fresh owned temporary **persistent Chromium profile**, using the browser's default disk cache, then removes that exact profile. It opens only the existing public plain-text notice entry, uses no accounts/cookies/service workers, verifies the supplied public CA and hostname/IP before pinning the verified leaf key, and streams at most the verified 128-MiB asset ceiling. It never imports/executes the engine or inspects a document.

Keep the profile/cache mode explicit: a large WASM response may exceed an ephemeral incognito context's cache allowance even when a normal profile retains it. Playwright request routing also disables HTTP caching, so a route-fulfilled synthetic page invalidates cache observations. Initial routed/incognito attempts are retained separately as rejected-method/incomplete-batch evidence, not silently discarded samples. Navigation to the public notice page establishes TLS before the asset measurement; these numbers are representation transfer/decompression/cache observations, not a cold connection or complete editor opening.

## Initial asset-only observation

The retained public-asset probe is `/tmp/hyori-editor-asset-profile-znbtsJ/report.json`. It sampled each shipping WASM once per requested encoding through the live verified-CA HTTP/2 gateway from the deployment host, discarded bodies, and touched no private files. Dynamic gzip reduced transferred bytes but took longer on that local path than identity delivery. This motivates deterministic precompressed sidecars, not a conclusion that compression explains complete editor startup. Browser compile, parse, first input, and durable save were not measured by that probe.

Immutable sidecars must be independently hash/length verified against their original JS/WASM, served with correct content negotiation/MIME/cache/range behavior, and installed only in a distinct immutable runtime. Keep the old runtime available for already-open sessions. Removing fonts, weakening validation, or relabeling old events is not a performance fix.
