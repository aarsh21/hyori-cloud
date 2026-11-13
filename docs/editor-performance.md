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

## What an editor downloads before it is usable (r2, 2026-11-12)

Sizes come from the committed r2 receipts (`tooling/artcraft/builds/native-host-v3-r2/<app>/receipt.json`). Compressed sizes are **estimates**: they apply the ratios measured on the official upstream WASM of the same upstream version (measured in a review orb on 2026-11-12 with Node zlib and zstd; gzip at the sidecar encoder's level 6). The r2 bundle's eight recorded gzip sidecars total 56,026,063 bytes, against 55.8 MB predicted by those ratios, so the transfer is credible but still not a measurement of the r2 bytes.

| Editor | r2 WASM raw | gzip-6 (shipped sidecar, est.) | Brotli-11 (est.) | zstd-19 (est.) | Other first-load files                               |
| ------ | ----------- | ------------------------------ | ---------------- | -------------- | ---------------------------------------------------- |
| Word   | 46,509,177  | 17.4 MB (37.4%)                | 10.0 MB (21.6%)  | 11.1 MB        | 178 KB JS, 219 KB host bridge, 2 KB index, 4 KB icon |
| Grid   | 23,063,754  | 8.6 MB (37.5%)                 | 5.5 MB (24.0%)   | 6.0 MB         | 170 KB JS, 219 KB host bridge                        |
| PDF    | 47,343,900  | 17.6 MB (37.3%)                | 10.8 MB (22.9%)  | 11.7 MB        | 175 KB JS, 219 KB host bridge                        |
| Deck   | 33,240,933  | 12.1 MB (36.4%)                | 7.4 MB (22.2%)   | 8.0 MB         | 167 KB JS, 219 KB host bridge                        |

- Brotli-11 sidecars would cut each WASM transfer by a further 36–42% compared with the shipped gzip-6 sidecars (about 22 MB across the four editors). Brotli-11 took 77–153 s per WASM on a 2-CPU orb, which is build time, not request time. Shipping them needs `.br` sidecars in a new verified runtime inventory, Brotli verification beside `verify_sidecar` in `apps/server/src/editor_assets.rs`, and `precompressed br gzip` in `scripts/editor-static-handler.ts`; none of this is implemented.
- The top-level hashed JS and WASM are `immutable` for a year. `index.html`, `snippets/**` (including the 219 KB `hyori-native-host.js`) and the icon are `no-cache`, so every open revalidates them, and the bridge has no precompressed sidecar (dynamic gzip only).
- Nothing warms an editor before the click. The frame starts empty, the SDK calls `editors.open`, and only its reply supplies `assetUrl`. The WASM request therefore starts after that round trip. The document download runs in parallel with frame loading.
- Every attachment instantiates a fresh engine. Browser compiled-code caching of a 23–47 MB module across attachments is implementation-dependent and unmeasured here.

## Commands for real open and save timings

None of the committed tools produces parsed-open or durable-save timings yet. The packet observer in `scripts/browser-fixtures/native-performance*.ts` and its phase calculator are not wired into any scenario. Until a runner exists, these commands produce the parts that can be measured, on a machine with the verified r3 bundle (the only one this release opens):

```sh
# 1. Asset transfer per editor, fresh persistent Chromium profile, through the HTTPS gateway.
#    ORIGIN and CA are the gateway serving the r3 bundle and the public CA that signed its certificate.
ORIGIN=https://127.0.0.1:8443 CA=/path/to/public-ca.pem
for asset in \
  wordcraft/0.14.0-hyori-host.4/wordcraft-web-6b3ea47acb14e3b9_bg.wasm \
  gridcraft/0.15.0-hyori-host.3/gridcraft-web-8ce58001aed44fba_bg.wasm \
  pdfcraft/0.17.0-hyori-host.3/pdfcraft-web-951fa5aea2bb0fee_bg.wasm \
  deckcraft/0.14.1-hyori-host.6/deckcraft-web-6cdd1e239b1a2cfd_bg.wasm; do
  bun scripts/profile-editor-static.ts "$ORIGIN" "/artcraft/$asset" "$CA" "/tmp/editor-static-${asset%%/*}.json"
done

# 2. Real editors in a real browser against a built server image and the bundle (pass/fail per step).
bun scripts/test-rust-browser.ts hyori-server:local --scenarios=editors \
  --editor-bundle=tooling/artcraft/.generated/runtime-all4-native-v3-r3 \
  --editor-bundle-sha256=4fbf87ab7eb17b0c2009473bef195f45043e39ff8654f606692c4b4f983b615e \
  --artifacts=/tmp/editor-browser-$(date +%s)
```

A timing runner should call `installNativePerformanceObserver` before navigation, mark `activation` on the click and `input-start` before typing, then report `nativePerformancePhases` over the `nativePerformanceMatrix` profiles (five fresh profiles, one cold and two warm attachments each), plus the `completeSave` response time from the SDK for durability. Measure each editor with the small fixtures in the workload table above.

## r4 paired local open measurements — 2026-11-13

The r4 review used that observer, including its sandboxed-frame support, in a retained scratch runner. Before is `23d927f` with r3; after is the r4 working tree and manifest `32227230…fed7`. Each editor has five fresh persistent Chromium profiles, one cold and two cleanly closed warm attachments per profile: five cold and ten warm observations, all 60 successful per batch. Conditions: Ryzen 5 4600H, Chromium 156.0.8078.4 with SwiftShader, production Nitro, disposable real PostgreSQL/RustFS/server, loopback verified HTTPS/Caddy HTTP/2. No competing worker jobs ran. Generated small fixtures have the same contents/workload; ZIP timestamps and therefore archive hashes vary. This is neither a physical-device/LAN measurement nor the two-core deployment baseline.

These historical numbers use the trusted click timestamp to receipt of `opened`, not visible document content. Subsequent compositor captures show that `opened` and even the first GPU draw can precede the document's text, values, page or slide. They are lower bounds to visible content, not usable-open timings. The observer's earlier automation activation mark includes about 124–140 ms of click scheduling and is retained separately, not charged as product time. Times are milliseconds, median (min–max), with half milliseconds retained rather than rounded down:

| Editor | r3 warm, n=10    | r4 warm, n=10     | r3 cold, n=5     | r4 cold, n=5     |
| ------ | ---------------- | ----------------- | ---------------- | ---------------- |
| Word   | 1259 (856–1342)  | 1154.5 (753–1297) | 1344 (1313–1416) | 1276 (1219–1440) |
| Grid   | 982.5 (598–1225) | 858.5 (550–888)   | 883 (863–1070)   | 790 (581–871)    |
| PDF    | 1061 (1032–1106) | 973 (955–1001)    | 1389 (1332–2102) | 989 (969–1032)   |
| Deck   | 1137 (1005–1168) | 1083.5 (884–1117) | 1207 (1178–1343) | 1016 (944–1084)  |

Only Grid meets the provisional warm target for every sample on that historical lower-bound measure. The visible-content target is not established for any editor by this table. No threshold was relaxed. All four retain the opaque sandbox and host digest/length verification. The safe change removes the unused Trunk WASM preload; other r4 fixes ship in the same comparison, so this is not an isolated preload-only causal benchmark.

The observer localizes most remaining time after engine bytes arrive: r4 warm median engine-end→ready / ready→parsed is Word 474/448 ms, Grid 313/356 ms, PDF 350/364 ms, Deck 493/396 ms. Engine-end also precedes module instantiation, so this is not a pure CPU breakdown. Font/engine initialization has not been individually attributed by a profiler. Meeting the remaining worst-case target needs further initialization/parse investigation; no evidence establishes that weakening isolation or validation is necessary, and neither was weakened. Raw observations, fixture hashes, frontend/image identities and screenshots are retained under `.amp/in/artifacts/editors-r4/timing-before-23d927f/` and `timing-after/` on Hyorinmaru. The scratch driver is review evidence, not a new committed benchmark command. The old r3 run on `205bfda` used another head and is not substituted for this paired baseline.

## r5: handoff profiling and visible-content boundary

r5 removes a whole-engine `Response(ArrayBuffer)` copy by streaming the transferred, already verified buffer. It does not remove digest/length verification, change the sandbox or relax CSP. r5 is the development default, accepted for its Deck paste repair and not for speed; r4 remains accepted by the server. These measurements were taken while r5 was a candidate. Its manifest is `2e248a3aedfbd976bc28d29d44f52dec8e7ddbdf4149b1e28cc4a2613f3b7b25`.

Same local stack and small workloads, alternating build order across five fresh profiles, one cold and two warm attachments each. The lightweight probe measures click to the later of first post-open GPU submission and host-cover removal. **That endpoint can still show only editor chrome; all entries below are lower bounds to visible content.** Each entry is median (range), milliseconds. Word/Grid/PDF use the initial candidate: every asset and descriptor is byte-identical in the repaired candidate. Deck was repeated on the repaired build.

| Editor | r4 warm lower bound, n=10 | r5 warm lower bound, n=10 | r4 / r5 `hostOpened` receipt median |
| ------ | ------------------------- | ------------------------- | ----------------------------------- |
| Word   | 1400.35 (1364.9–1420)     | 1357.15 (1315.8–1376.8)   | 1397.85 / 1353.3                    |
| Grid   | 1008 (984–1033.1)         | 979.4 (963–988.5)         | 1003.6 / 973.45                     |
| PDF    | 1145.45 (1121.1–1182.2)   | 1094.2 (1061–1138)        | 1142.5 / 1090.6                     |
| Deck   | 1208.05 (1167.1–1232.9)   | 1145.25 (1106.1–1218.2)   | 1206 / 1143.05                      |

Four warm heavy-probe observations per build/editor account for that lower-bound endpoint without an arithmetic gap. They do not account for the later compositor presentation. Mean r5 milliseconds, aggregated from the retained per-span ledger:

| Editor | Host route/RPC/React and cover | Frame assets/verification/transfer, compile and bridge | Engine initialization, startup, open and first GPU submission | Total lower bound |
| ------ | ------------------------------ | ------------------------------------------------------ | ------------------------------------------------------------- | ----------------- |
| Word   | 82.3                           | 471.9                                                  | 810.1                                                         | 1364.2            |
| Grid   | 88.9                           | 283.1                                                  | 620.2                                                         | 992.3             |
| PDF    | 81.0                           | 480.1                                                  | 532.3                                                         | 1093.5            |
| Deck   | 82.9                           | 370.7                                                  | 698.6                                                         | 1152.2            |

Displayed tenths may sum differently by 0.1 ms; raw span sums have zero gap. Engine initialization/startup attribution uses time inside synchronous WASM exports around `hostReady`/`hostTakeOpen`; it does not identify individual upstream functions or prove an unavoidable upstream limit. Heavy instrumentation and screencasting add overhead; their absolute values are not substituted into the lightweight batch.

Inspected compositor captures identify actual Word body text, Grid cell values, a rendered PDF page and the Deck slide. One pair per editor; times below are the first captured frame with that content, not a median or a normal warm-open benchmark. The interval is candidate-minus-base bounded by the immediately preceding captured frame without content. Existing captures are reused for Word/Grid/PDF; only Deck was recaptured after its approved repair, using a byte-identical fresh fixture.

| Editor | r4 visible frame | r5 visible frame | r5 − r4, captured-frame difference | Transition-difference interval |
| ------ | ---------------- | ---------------- | ---------------------------------- | ------------------------------ |
| Word   | 2550.5 ms        | 2523.1 ms        | −27.4 ms                           | −77.4 to +22.6 ms              |
| Grid   | 2015.3 ms        | 2000.1 ms        | −15.3 ms                           | −48.6 to +34.7 ms              |
| PDF    | 1554.7 ms        | 1589.4 ms        | +34.8 ms                           | −15.2 to +84.7 ms              |
| Deck   | 2167.9 ms        | 2222.8 ms        | +54.9 ms                           | +4.9 to +104.9 ms              |

Direction remains unknown as a repeatable performance result for all four: three intervals overlap zero; Deck is later in its single captured pair, not proof of a population regression. Screencast overhead is substantial. No speed or visible-content non-regression claim is made, and the 1000 ms worst-case visible-content target is unproven. The host can say “Ready to edit” over blank Word chrome or an empty Grid, and PDF can still say “Rendering...”. A future engine-owned content-presented signal would let the host measure and mask that interval correctly; a timer would not prove readiness. Raw traces, failed/discarded trials, captures, cold rows, instrumentation controls and exact commands are in the r5 evidence handoff on Hyorinmaru.
