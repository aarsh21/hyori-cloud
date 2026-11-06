# Release metadata characterization

**Current-host characterization only. Target client devices and deployment conditions have not been agreed. These measurements do not establish supported capacity, NAS performance, browser responsiveness, or full-stack transfer capacity.**

## Protocol fixed before measurement

Run `bun scripts/benchmark-rust-metadata.ts` with the already-built local image `hyori-rust-verification:uploads-t3-ce2b2e51`. The harness resolves and runs its immutable image ID; it does not rebuild the frozen server/storage/API/SDK implementation or install dependencies.

- Exactly 100,000 synthetic items across ten accounts, including three folders, 20,000 JPEG metadata entries and 79,997 PDF metadata entries. No original object bytes are seeded. Accounts and short-lived session digests are inserted by fixture-only SQL; login/setup/KDF work is neither timed nor validated by this harness.
- Owner 0 has 100 root entries and folders with exactly 100, 1,000 and 10,000 children. Owners 1 and 2 have 1,000 and 10,000 root entries. Other accounts supply the remaining private population.
- Account 9 receives 1,200 direct Viewer grants to owner 2 files and one inherited Contributor grant to owner 0's 10,000-child folder. Shared roots therefore expose 1,201 directly shared entries. A private sentinel name in another account must never be returned.
- Thirteen fixed journeys: three root sizes; three folder sizes; a second 10,000-folder keyset page; inherited folder; >1,000 incoming grants; private/shared name searches; MIME/date/size filtering; unauthorized-name search.
- Successful listing/search/filter pages contain exactly 100 stable, sorted, unique IDs; unauthorized-name search contains zero. Every result is checked against the synthetic fixture's permitted identities, capability flags, and requested filters. Those assertions do not filter or construct product results.
- One sequential first pass after restarting PostgreSQL and the server. This resets their process-local caches but **does not flush host OS/filesystem/device caches**; it is not a cold-cache experiment. Later requests in this pass can benefit from earlier requests.
- Three untimed warmups per journey, then 100 sequential timed requests per journey. A separate warm phase uses ten independent SDK consumers running ten closed-loop requests each against the same journey/account, without think time. This is a hot-page concurrency characterization, not an open-loop capacity test or ten distinct-account traffic model.
- Fixed candidate comparisons: p95 ≤150 ms for listing; p95 ≤300 ms for name searches and filtering. These are inspired by the **proposed server** budgets in `rust-rewrite.md`, not agreed acceptance SLOs. Measured SDK end-to-end time has a wider boundary; comparisons are labelled accordingly. Nearest-rank quantiles include all failed/timed-out requests, and any functional failure fails its candidate comparison. Budgets are not raised after measurement.
- Timing includes SDK encode/decode, an in-process invocation of the owned Fetch proxy, real loopback HTTP to the production-mode release container, server logic and PostgreSQL. It excludes a client-to-proxy socket, TLS, browser/render/INP/navigation, WAN, binary transfers, Photos endpoints, versions/trash and mixed-transfer capacity.
- No CPU/memory/cpuset limits are imposed. This is **not** a 2-CPU/4-GiB aggregate fixture. Resource snapshots and host load/swap are recorded; other host work is not controlled or suppressed.
- PostgreSQL 17 uses `pg_stat_statements` including planning and utility tracking. This instrumentation has overhead. Counters are reset before each measured journey/phase and restricted to the application DB role, excluding fixture SQL. Query counts include transaction-control/SET statements; report them separately from data queries.
- After timing, briefly enable SQL statement logging with parameter logging disabled, capture the actual release-image listing/role SQL, and run `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` against the same fixture. Listing plans force both custom and generic alternatives; these do not establish which auto-plan choice each pooled application connection used. Role plans cover the 100 returned rows, excluding a possible 101st lookahead row.
- Only uniquely named disposable PostgreSQL/RustFS/server containers and their own private Docker network are removed. PostgreSQL is not published; server and RustFS ports bind loopback only. Random synthetic credentials are neither printed nor saved. PostgreSQL data uses its disposable container volume; RustFS uses tmpfs. The server remains read-only, UID 10001, with capabilities dropped.

## Artifacts and reproduction

The harness creates `/tmp/hyori-metadata-benchmark-*` with synthetic-only `conditions.json`, `environment.json`, `workload.json`, `container-limits.json`, PostgreSQL settings, seed SQL, raw `timings.ndjson`, separate warmups, per-phase query counters, resource snapshots, captured SQL, EXPLAIN JSON, and a completion marker. Timings are bounded to 100 rows in memory per batch and written incrementally. Preserve the artifacts before deleting temporary files.

```sh
bun test scripts/benchmark-rust-metadata.test.ts
bun run check:scripts-types
bun scripts/benchmark-rust-metadata.ts
bun run lint:anti-slop
```

## Actual results — 2026-11-05

Three complete runs are retained, not selected by their speed. Each has 2,613 measured requests (13 first-pass observations + 1,300 warm sequential + 1,300 warm concurrent), plus 39 separately recorded warmups. All three had **zero measured functional failures**. This means the fixture's scope/filter/cursor assertions passed, not that broader security or capacity has been proven.

The final run, `uREpG8`, fixed its conditions at **00:27:22.643 UTC** and completed at **00:30:07.560 UTC**. Its public SDK/API/lib/core source snapshot was hashed before dynamic import, checked immediately after import, and checked again after measurement/plans: all **83 file hashes remained unchanged**. Package versions are `0.0.0`; these versions and Git HEAD alone do not identify the uncommitted client implementation, so use the recorded source manifest.

### Exact software identity

| Component | Identity |
|---|---|
| Tested release server image | `sha256:f80c86dcb9aa437fc13fc7fc16f17cad65105ad3e8932e812760d034b5c51c9a` |
| Image tag checked against that ID | `hyori-rust-verification:uploads-t3-ce2b2e51` |
| PostgreSQL image | `sha256:327daa8fae7178d61f93142f146b098467b345e10997b9eb79f63bd58e5c8f3c` |
| RustFS image | `sha256:cffb90dadc42b024ee57e1ac5a8f1f92acfc1d009d1460fdcf84648e106a4609` |
| Final harness SHA-256 | `34bc3648ddf068056a6aa1872a970f5a203f13b9dfb6e0061d4e579c7a4146ce` |
| Before/after client-source manifest digest | `06c7f5721a74d38d5567e55ee358e1637a6bf7a75c999a7f1c15a7485f004cdb` |
| Actual generated operations SHA-256 | `329bdb38f58449bbbdb2682c3de439a5faee989cdc1755e2bfe837a0727ba750` |
| Actual generated schemas SHA-256 | `b3d0223e5eb2f6777e3972cc621713bdb8825e6f3dca5e17db79ab0ff28545f1` |
| Actual SDK checkpoint source SHA-256 | `7f423ec17b35743c63a98c6e17315d0e1d81256b543fa227fdd8bddb31108d51` |
| Worktree base HEAD, not a clean snapshot | `83c768a687da9acd455e9d6ba542cec21fd23b49` |

**The measured server image predates the parent's subsequent grant-continuity fix and Photos implementation work. These numbers must not be attributed to current Rust source or used as security acceptance of that older image.** The final run used the actual current public SDK/generated operations at the recorded snapshot, including the client-side checkpoint changes; checkpoint behavior itself is not exercised by this metadata benchmark. Nothing was rebuilt or optimized for this task.

### Host, instrumentation, and uncontrolled concurrent work

- AMD Ryzen 5 4600H, six physical cores / twelve logical CPUs, boost enabled; 16,093,499,392 bytes RAM (~14.99 GiB). Kernel `7.2.11-arch1-1`, Docker `29.9.2`, cgroup v2, Bun `1.4.4`.
- Docker `overlay2` with `/var/lib/docker` on the Samsung MZVLB256HBHQ NVMe-backed Btrfs root filesystem, `compress=zstd:3`. PostgreSQL's disposable volume uses that host backing storage; RustFS uses tmpfs and stores no original file workload here.
- All three containers report empty CPU sets, `NanoCpus=0`, `Memory=0`, `MemorySwap=0`. No aggregate CPU/RAM envelope was established. The host-resident Bun SDK/proxy driver also has no benchmark-imposed limit.
- PostgreSQL **17.11**, `shared_buffers=128 MiB`, `work_mem=4 MiB`, `effective_cache_size=4 GiB` (planner estimate, **not a RAM limit**), `max_connections=100`, JIT on, auto plan cache, I/O timing off. Statement logging was off during timings. `pg_stat_statements` tracked execution, planning and utility statements.
- Fixture database size after seed/ANALYZE: **54,859,443 bytes**; `hyori_items` including indexes: **45,735,936 bytes**; shares including indexes: **581,632 bytes**. This small metadata working set does not test a library larger than RAM.
- The parent reported concurrent **Photos Rust/SDK compilation, isolated Deck WASM building, and short Docker acceptance fixtures** on this same host. Those jobs were neither stopped nor pinned away. Host load, swap activity and scheduling are confounders; there is no per-sample attribution to another process.

Final-run boundary snapshots, not peaks or steady-state utilization:

| Boundary | Host load average, 1/5/15 min | MemAvailable | PostgreSQL / RustFS / server memory |
|---|---|---|---|
| Before first pass | 3.82 / 3.29 / 2.74 | 8,816,316 KiB | 25.38 / 67.86 / 52.38 MiB |
| After sequential | 3.57 / 3.35 / 2.83 | 8,824,060 KiB | 191.1 / 77.36 / 55.7 MiB |
| After ten-client phase | 4.21 / 3.50 / 2.89 | 8,572,192 KiB | 404.2 / 77.23 / 66.34 MiB |

Swap was already in use. These snapshots exclude driver memory and are not complete-stack peak accounting. Low CPU percentages in `docker stats` taken between phases do not describe utilization during the requests. **Do not describe this as a controlled quiet host, a cold cache, or supported 2-CPU/4-GiB NAS capacity.**

### Final-run end-to-end timings

All values are milliseconds. Warm columns have **100 samples each**. The first-pass column is **one observation**, not a statistically meaningful p95 or a cold-cache latency. Candidate comparisons are for the wider SDK boundary, not isolated server latency.

| Journey | First pass | Sequential p50 | Sequential p95 | Ten-client p50 | Ten-client p95 | Fixed candidate p95 |
|---|---:|---:|---:|---:|---:|---:|
| Root, 100 entries | 665.39 | 330.02 | **359.86** | 550.86 | **718.75** | 150 |
| Root, 1,000 entries | 377.80 | 85.24 | 87.78 | 147.49 | **159.26** | 150 |
| Root, 10,000 entries | 309.21 | 89.06 | 91.53 | 151.10 | **166.45** | 150 |
| Folder, 100 children | 320.59 | 328.50 | **340.28** | 532.27 | **595.19** | 150 |
| Folder, 1,000 children | 325.77 | 5.73 | 6.77 | 13.89 | 16.74 | 150 |
| Folder, 10,000 children | 10.26 | 6.69 | 7.78 | 13.78 | 16.71 | 150 |
| Folder, 10,000, page two | 9.16 | 5.43 | 6.72 | 12.95 | 15.76 | 150 |
| Inherited folder, 10,000 | 9.34 | 15.54 | 16.95 | 24.00 | 29.00 | 150 |
| Shared roots, 1,201 grants | 66.74 | 69.58 | 78.41 | 117.41 | 127.72 | 150 |
| Private name search | 7.69 | 5.41 | 6.78 | 13.64 | 17.53 | 300 |
| Shared name search | 10.26 | 8.42 | 9.44 | 14.14 | 20.49 | 300 |
| MIME/date/size filtering | 12.34 | 7.32 | 14.27 | 14.65 | 18.83 | 300 |
| Private sentinel denied, zero rows | 61.78 | 59.74 | 61.19 | 104.44 | 112.25 | 300 |

Bold values miss the fixed candidate. No failure or slow sample was discarded, no budget was raised, and these results do not establish that larger folders are generally cheaper than smaller folders.

Earlier runs are retained to show variability rather than cherry-picking the final numbers. Selected ten-client p95s:

| Journey | Run 1 `qAkpcc` | Run 2 `ysPPTH` | Final `uREpG8` |
|---|---:|---:|---:|
| Root 100 | 730.96 | 784.56 | 718.75 |
| Root 1,000 | 161.43 | 193.59 | 159.26 |
| Root 10,000 | 174.92 | 209.81 | 166.45 |
| Folder 100 | 618.73 | 635.75 | 595.19 |
| Shared 1,201 grants | 133.95 | 130.27 | 127.72 |

Runs 1 and 2 used the same image/protocol and their own fresh fixtures, but did not yet have before/after SDK-source manifests; they are secondary observations, not an assertion of identical client bytes. Run 2 added fixture ownership/cursor assertions and checked the pinned image ID. Final instrumentation added client provenance and the parent's concurrency/image-scope caveats, without changing the dataset, timings, concurrency or budgets. An initial `L5YCVH` preflight failed before timing because this Docker host did not publish ports on an `--internal` network; the harness uses its own bridge with only loopback-published ports instead. That partial artifact is also retained.

### Query counts and plans

Each timed operation is one real public `files.list` SDK request. App-role `pg_stat_statements` shows the following request shapes, not one SQL request per rendered row:

| Journey shape | Data-query calls per request | Transaction/SET calls | Normal total |
|---|---:|---:|---:|
| Root, shared-root, successful root search | 3: identity, authorized listing, batched roles | 5 | 8 |
| Explicit folder, second page, inherited folder, folder filters | 7: identity, folder, active owner, folder roles, listing, batched roles, ancestor lookup | 5 | 12 |
| Empty denied-name search | 2: identity and authorized listing | 5 | 7 |

Maintenance remains enabled. For example, final sequential root-100 recorded **816** total calls instead of 800, and folder-100 **1,215** instead of 1,200; the additional auth/upload maintenance and transaction-control statements are separately identifiable in raw query files. Do not attribute every app-role call to a timed request. No SQL counter reset/seeding/EXPLAIN query from the fixture-admin role is included.

Actual listing-query average execution time from the timed sequential requests was **331.74 ms** for root-100, **323.16 ms** for folder-100, **0.37 ms** for folder-1,000, **8.75 ms** for inherited-folder-10,000, **65.27 ms** for shared roots, and **57.78 ms** for the denied-name search. These averages are database execution counters, **not** server-request p95s.

The archive contains 38 `EXPLAIN (ANALYZE, BUFFERS)` JSON plans per completed run, plus the actual SQL captured from the immutable image after timing. Selected final diagnostic plans:

| Listing plan / forced mode | Execution ms | Shared buffer hits / reads | Relevant observation |
|---|---:|---:|---|
| Root-100 / generic | 1,462.73 | 180,924 / 0 | 100 returned, 99,900 rows removed; 88,800 authorization subplan loops |
| Folder-100 / generic | 1,459.71 | 180,924 / 0 | Same full 100,000-item scan while seeking an absent 101st match |
| Folder-1,000 / generic | 1.41 | 11 / 0 | Stops after 101 qualifying rows; only 200 rows removed |
| Shared roots / generic | 236.87 | 37,215 / 0 | 12,199 rows removed; 12,300 authorization subplan loops before 101 rows |
| Denied-name search / generic | 54.72 | 2,125 / 0 | Removes all 100,000 rows; no successful result |
| Folder-1,000 / custom | 343.66 | 11 / 0 | JIT compilation accounts for 327.42 ms |
| MIME/date/size / custom | 359.52 | 70 / 0 | JIT compilation accounts for 342.76 ms |

EXPLAIN per-node timing instrumentation can substantially increase execution time in heavily repeated subplans. Those diagnostic times must not replace the measured SDK timings or be presented as additional SDK samples. Forced custom/generic plans are alternative plans on the same fixture, not proof of every pooled connection's automatic plan choice.

### Remaining bottlenecks and limitations

1. **Bounded output does not bound database work.** A 100-row scope requesting a 101st lookahead can scan the entire fixture. The broad authorization `OR` and parameterized parent/shared conditions can leave the primary-key scan doing scope rejection and many share probes instead of a narrowly bounded parent/owner access path. The captured plans and execution counters warrant a separate, authorization-preserving query-shape investigation after the freeze. No implementation or index was changed here.
2. **Plan/JIT sensitivity merits a separate experiment.** Forced custom plans can spend ~327–343 ms compiling tiny-result queries that run much more cheaply under a generic alternative. This suggests investigating plan-cache/JIT interactions; it does not prove that JIT explains every slow production request.
3. **Negative substring search scans the library.** The denied sentinel returns no metadata, but the generic diagnostic plan examines all 100,000 rows. No million-item or out-of-RAM extrapolation is justified.
4. **Synthetic distribution matters.** IDs are deterministic and clustered by owner/folder rather than production-random opaque IDs. This makes some first-page early exits favorable and is not a broad selectivity/ID-distribution study. The fixture has three shallow folders, no deep hierarchy, no anonymous/password-link transfer traffic, no trash/version population and no original bytes.
5. **Concurrency is closed-loop and hot-scope.** Ten consumers of the same account/journey are not ten independent-account mixed workloads; request arrivals slow when the server slows. There is no saturation, queue-depth, sustained-throughput, open-loop arrival, or coordinated-omission correction study.
6. **Host interference is material.** Compiles, WASM builds and other Docker fixtures were uncontrolled. Three runs show variation but do not produce a quiet-host confidence interval. Resource snapshots are coarse, not peaks or per-sample attribution. No browser, INP, TLS/WAN, transfer contention, operational durability, or supported-capacity claim follows.
7. **Current source differs from the image.** The grant-continuity fix and subsequent Photos work require their own rebuilt-image correctness and performance verification. This characterization is deliberately tied to the older requested image.

## Retained evidence and checks

All raw observations, warmups, query counters, 114 diagnostic plans across three complete runs, source manifests for the final run, and partial-preflight metadata are retained in:

`/home/aarsh/.t3/userdata/attachments/hyori-metadata-release-20261105-all-three-runs.tar.gz`

Archive SHA-256: `56660298407edf2c5394645945be3e581d42343f99b6c220249728ca78f65f70`.

Final raw timing rows: `/tmp/hyori-metadata-benchmark-uREpG8/timings.ndjson`, SHA-256 `e227ada22cc06dfe6ddaf39079e656a971bb41c193a3a62a99d029822966ec16`. Final summary SHA-256: `a5c761f45ea8dff6fb3b69f475a9b203349c3d4f3cf959fc52d73ceb50bf5a5a`. Temporary directories are conveniences; retain the archive because `/tmp` can be cleared.

Verification at the final measured harness snapshot:

- `bun run check:scripts-types`: passed.
- `bun test scripts/benchmark-rust-metadata.test.ts`: **7 passed**, 32 assertions; percentile/failure accounting, fixed conditions, fixture-derived ownership and real source provenance.
- Local formatter and focused lint on the two new scripts: passed.
- `bun run lint:anti-slop`: **passed at the final verification checkpoint**. Earlier runs failed on concurrent ArtCraft/SDK-test edits and `scripts/test-rust-photos-sdk.ts` spacing diagnostics, all outside this task's scope and left untouched. Because other tasks remain active, rerun this workspace-wide gate at integration.
- All benchmark-owned containers and networks were removed. No pre-existing services/volumes or frozen application/SDK implementation files were edited by this task.

## SQL query-shape experiments — 2026-11-05, separate from the release benchmark

**SQL-only fixture evidence, not SDK/server acceptance, an end-to-end speed result, a quiet-host experiment, or supported capacity.** The original 7,839 requests, tables, raw artifacts and archive checksum above are unchanged. This section records a later experiment in `scripts/metadata-query-experiments.ts`; no production Rust, storage, SDK, query generator, index, migration or JIT setting was optimized by this task.

### Applicability, inputs, and source identity

Before each fixture run, the harness extracts the current listing query from `apps/server/src/features/files/service.rs` and compares it with `executed-list.sql` captured from the earlier release image. The current file includes later Photos/preview work, but **the listing SQL matches after whitespace normalization**. The harness refuses to continue if that comparison changes. It also extracts the current batched role query and current public-grant resolution query from `files/policy.rs` rather than substituting an old resolver.

Final run `qXqYJS`, conditions recorded 01:42:59.401 UTC, completed 01:55:38.205 UTC:

| Evidence | SHA-256 |
|---|---|
| Current `files/service.rs` snapshot | `4357d00fc1bcd4ef6fe850ac5279513e8d8d382f75940cba007131fe31819982` |
| Extracted current listing SQL | `4b64d510270b8cb66a46131de370d1a55236e88f14f12e978f4216adbf25a05f` |
| Earlier captured SQL, raw whitespace retained | `baddf669a7d8b88df8ecd93fc5c694709bd6b7f033f658c05f7092006f985b31` |
| Shared normalized listing SQL | `f70145e52ea74c1741c3b067f881ca7db77bdd304c8e8302ca8e9d9cd8898ebf` |
| Current batched-role SQL | `fd3d4857c9c1a0171ccae03c94f5393c2d6b31df86fe669f972c8a57cc7acb2a` |
| Current grant-resolution SQL | `731034b288b20a04931a90571155604b0ff8cf4e5f97b8ece0f568917fa1db08` |
| Executed experiment harness | `acaa45efa4105bdd4b13e67112c954191b3a9a64ba8c0fb5832b8f0cac056616` |

The listing file/query still matched at the end. These hashes establish applicability of the SQL comparison, **not equivalence of the current application to the older release image**.

Only uniquely named disposable PostgreSQL containers were started, using the same pinned PostgreSQL image ID `sha256:327daa8fae7178d61f93142f146b098467b345e10997b9eb79f63bd58e5c8f3c`, a random disposable password and a loopback-only port. The harness loads migrations **0001 and 0002 only**, whose hashes are saved, and reuses the original synthetic seed function without modifying it. It does not touch the admin-owned later migrations. No extensions or additional indexes were installed. The only extra database functions are fixture-local result/EXPLAIN helpers; every fixture was removed afterward.

The original thirteen journeys run against exactly 100,000 items, ten accounts and 1,201 active incoming shares. Edge fixtures then add 125 items, two accounts and nine shares (including invalid/expired controls), with a nested overlapping-share subtree and two owned trash groups. Later phases expire a grant, revoke a direct grant while inherited access remains, disable an owner, and finally revoke all active shares. Those phases are explicitly labelled in artifacts; they do not replace the original dataset or timing results.

Every value is passed through Bun SQL bindings. Fixture helpers receive JSON through a bound `text` parameter cast to JSONB, avoiding Bun's JSON double-encoding of a pre-serialized string. PostgreSQL prepared statements declare the thirteen parameter types explicitly. Their fixture-only EXECUTE helpers use `%I` for statement identifiers and `%L` for each parameter value; no search/name/cursor/authority value is concatenated into query predicates. Only fixed SQL fragments are selected. Parameter order is:

1. Current actor account ID or null.
2. JSON array of **currently resolved** public share IDs.
3. Cursor.
4. Trash flag.
5. Shared flag.
6. Parent ID or null.
7. Lowercased search.
8. Type/MIME filter.
9–10. Inclusive after/before timestamps.
11–12. Inclusive minimum/maximum sizes.
13. Requested page limit plus one, normally 101.

The scope selector is experimental tooling, **not a proposed public API or reusable framework**. Source queries, each selected shape, exact synthetic parameters, ordered-result digests, and plans are retained. Custom and generic plans are forced separately. JIT stays on. Plans use `EXPLAIN (ANALYZE, BUFFERS, TIMING OFF, FORMAT JSON)`; three samples per primary journey/mode/variant and one per edge case are diagnostic observations, not latency percentiles. TIMING OFF avoids much of the per-node timing overhead present in the earlier release-plan captures, so the two sets of EXPLAIN execution times are not directly comparable.

The final fixture used the same unconstrained Ryzen 5 4600H / twelve-logical-CPU / ~15-GiB host. Load averages changed from 0.95/1.03/1.89 to 2.43/2.09/2.12. Concurrent Deck builds, compiles and other acceptance fixtures remained uncontrolled. The 30-second statement timeout was not raised.

### Equivalence coverage

The final run passed **276 checks across 46 cases and both plan modes**, including 92 baseline controls and 184 non-baseline selector/scoped-query comparisons. Some selected fallback queries are byte-identical to baseline. It retained **432 analyzed plans**, plus an explicitly labelled estimate-only plan for a rejected timeout.

Checks compare all selected persistence columns, the full ordered lookahead result, the visible page and next cursor. The actual current role SQL is executed for both result sets; a fixture projection of the current capability formulas compares owner/role/download/upload/edit/delete/share flags. Strongest-role expectations are asserted on overlapping grants, and owner-only deletion remains false for shared editors. This is **not execution of Rust's projector or HTTP pipeline**.

Coverage includes:

- All thirteen original root/folder/search/filter/cursor journeys.
- Private/no-active-sharing accounts and an empty account.
- More than 1,000 direct grants, including a result behind the 1,000th grant; no eligible-grant LIMIT is introduced.
- Overlapping direct, inherited and nested grants; deduplicated pages and strongest roles; first and final nested pages.
- A foreign accessible item at the ordinary root, rather than incorrectly treating root browsing as owned-only.
- Shared-root type filters versus shared searches, which have different inheritance semantics.
- Account plus public authority, current active/expired/revoked links, expired grants, inactive issuers, and grant expiration followed by fresh resolution.
- Direct-grant revocation with remaining inherited Contributor access, plus owner disabling.
- Owned trash roots versus trash-group children, foreign trash exclusion, cursor/filter combinations, and the existing rule that the listing SQL ignores a supplied parent in Trash.
- Type, MIME prefix, inclusive dates/sizes including zero, uppercase search input, and SQL-like literal search text.

**Important service preconditions remain outside this SQL proof.** An unresolved anonymous grant must still fail `actor.require_access`; an inaccessible or trashed supplied parent must still fail the existing parent authorization before the query. The SQL fixture records zero-row behavior for those unprivileged parameter sets, not a successful empty API response. No stale resolved share IDs are reused after the expiry transition.

### Observed shape results and selection

The smallest supported handoff is deliberately partial:

1. **Explicit-parent listing:** replace the global CASE with `i.parent_id = <bound parent>`, retaining the original item authorization OR/EXISTS and active-owner/issuer checks. Add only the requested filter predicates, using bound values.
2. **Trash:** retain owner-only trash-group semantics in a separate explicit predicate, allowing the existing partial trash index.
3. **Shared roots only** (`view=shared`, no parent, empty search): materialize all eligible current share-root IDs once, deduplicate them, use indexed target-ID lookups, exclude owned/trashed/inactive-owner items, apply filters and cursor before the 101-row page, then fetch metadata for those IDs. Do not expand inherited descendants in this branch.
4. **Ordinary root browsing and library-wide search:** keep the baseline for now. The robust general replacement is **not solved** by this experiment. In particular, the original ordinary-root-100 and unauthorized no-match full-library scans remain in the recommended selector.

The final `recommended` selector was tested as a whole, not inferred solely from tests of its pieces. Primary values below are medians of three PostgreSQL execution observations in milliseconds, excluding Bun/SDK/Rust/HTTP. The trash row has one observation per mode.

| Journey | Baseline custom | Selected custom | Baseline generic | Selected generic |
|---|---:|---:|---:|---:|
| Folder 100 | 303.145 | 0.311 | 332.336 | 0.128 |
| Folder 1,000 | 306.580 | 0.099 | 0.235 | 0.125 |
| Folder 10,000 | 0.338 | 0.097 | 0.662 | 0.126 |
| Inherited folder 10,000 | 0.797 | 0.594 | 8.544 | 0.602 |
| Shared roots, 1,201 grants | 59.143 | 5.007 | 62.932 | 5.016 |
| Parent MIME/date/size filter | 310.257 | 20.022 | 1.208 | 0.668 |
| Owned trash groups, edge fixture | 0.043 | 0.032 | 26.771 | 0.061 |
| Ordinary root 100, **unchanged SQL** | 415.393 | 427.134 | 326.807 | 325.372 |
| Unauthorized no-match, **unchanged SQL** | 41.126 | 41.696 | 53.392 | 53.227 |

Differences between the unchanged SQL samples are measurement variation, not an optimization. The parent-filter custom plan still has plan/JIT sensitivity; no blanket claim is made across plan modes or filter selectivity.

Concrete generic-plan work counters from the final run:

| Case | Baseline item work / authorization probes / shared buffer hits | Selected work / probes / hits |
|---|---|---|
| Owner's 100-child folder | 100,000 examined / 88,800 / 180,924 | 100 examined via `hyori_items_parent_cursor` / 0 / 8 |
| Inherited 10,000-child folder, first page | 1,301 examined / 1,301 / 4,939 | 101 examined via parent index / 101 / 313 |
| Shared roots | 12,300 examined / 12,300 / 37,215 | 1,201 root-ID matches plus 101 metadata lookups / no per-item ancestry authorization subplan / 457 |
| Owned trash groups | 100,125 examined in enlarged edge fixture / 0 / 2,127 | 2 via `hyori_items_trash` / 0 / 4 |

An authorization-probe count of zero for an owner's folder does not mean authorization was disabled: current actor identity and active owner are still prerequisites, and the unchanged owner-or-share expression resolves through ownership. Inherited access still executes authorization for every selected candidate. Buffer hits count accesses, not unique pages; plan row/filter counts multiplied by loops are rounded PostgreSQL work estimates, not unique-item counts. The artifact counter records individual scan nodes to avoid presenting heap/index levels as distinct rows.

### Rejected broader shapes — retained, not hidden

- **Per-root share-driven UNION:** result-equivalent where completed, but the generic shared-search form timed out after **30,001.70 ms** in the final reproduction at the unchanged 30-second database timeout. Its estimate-only plan is explicitly not an analyzed plan with invented actual counters. Earlier completed samples are retained too.
- **Per-root materialized descendants:** all 276 equivalence checks passed in `CLv35t`, but generic-plan/JIT behavior produced roughly 0.6–0.8-second library/root cases. Materializing a scope is not sufficient evidence of a favorable plan.
- **One large GIN membership set:** all 276 checks passed in `6SNPh4`. It reduced ordinary private-root work (generic root-100 ~3.11 ms), but a 1,201-root membership set regressed inherited-folder listing to ~1,215 ms and unauthorized no-match to ~247 ms. This is not a safe universal replacement.
- **Prune only roots with actually empty descendant sets:** all 276 checks passed in `Vhf6b6`, without assuming a file/folder label or truncating grants. It reduced the large membership-set issue but introduced costly generic estimates/JIT; generic private-root-100 was ~538 ms and no-match ~599 ms. It was rejected rather than disabling JIT or lowering authorization work by dropping grants.
- The general `scoped` OR form improves parent access but regresses shared-root listing (~118 ms generic in one trial versus ~65 ms baseline); that is why shared roots use the separately tested root-ID shape.

Initial fixture-driver JSON-binding failure and a single-branch SQL-parenthesization error are also retained as incomplete trials; neither is reported as a product defect or an equivalence pass. All candidate variants remain in the new experiment script for inspection; its default selected comparison is baseline/scoped/recommended, and it deliberately reproduces the rejected UNION timeout once.

### Precise Rust handoff

The parent should implement only the selected branches inside the existing Files service/persistence owner, not add an SDK waterfall, new RPC, global mode framework, authorization cache or per-row API calls.

- Keep `FilesService::run` / the serializable transaction owner, `resolve_actor`, `require_access`, supplied-parent authorization and folder-kind validation unchanged. Trash's parent precheck remains even though its listing predicate ignores the parent.
- Keep the strongest-role `load_roles` query and `policy::project`, breadcrumbs, 100-row cap, `limit+1` lookahead and opaque-ID cursor behavior unchanged. In shared-root mode, ownership exclusion and deduplication occur before limiting. No direct grant inventory truncation is permissible.
- Use fixed SQL clauses and bound parameters. **Do not paste the artifact's sparse `$1…$13` placeholders straight into a SQLx/SeaORM call with unused parameter holes.** The fixture explicitly declares all thirteen PREPARE types; production should compact/remap the selected shape's values (for a simple parent listing: actor, public-share JSON, cursor, parent, limit+1), then append present filters with matching parameter indices. Preserve existing normalization/parsing before shape selection.
- Exact measured templates live in `qXqYJS/queries/base-folder-100-recommended.sql`, `base-shared-1201-grants-recommended.sql`, and `edges-trash-owned-groups-recommended.sql`, with per-case parameter JSON alongside them. The shared-root template is an unrolled single-root-ID shape; no descendant GIN branch or general UNION framework is needed in production for the selected handoff.
- Leave ordinary root browsing and no-parent name-search SQL untouched until a separately validated approach addresses both positive early exits and empty/unauthorized searches under custom and generic plans. The narrowed recommendation does **not** close those bottlenecks.
- Require production functional tests, existing real authorization/move/revocation snapshot races, high-grant and concurrent public-grant tests, public SDK/type/contract checks, a fresh release build, and rebenchmarking before adoption. Because other production work has changed since the old measured image, use a current pre-optimization image and a matched post-optimization image/SDK snapshot; do not attribute every difference from the old image to this SQL change. Do not overwrite the earlier image identity or results.

### Experiment artifacts, checks, and provenance maintenance

All seven exploratory/final fixture directories, raw queries/parameters, result digests, rejected outcomes, and plans are retained separately at:

`/home/aarsh/.t3/userdata/attachments/hyori-metadata-query-experiments-20261105.tar.gz`

SHA-256: `e4f638d5d9786ab15ca2b034544560dfd78b6e7c533d6e534c498b07204bb835`. The final complete directory is `/tmp/hyori-query-experiments-qXqYJS`; the archive should be retained if `/tmp` is cleared. No fixture credentials or production data are included. The original release archive remains byte-identical at `56660298407edf2c5394645945be3e581d42343f99b6c220249728ca78f65f70`.

Commands used:

```sh
bun scripts/metadata-query-experiments.ts
bun test scripts/metadata-query-experiments.test.ts scripts/benchmark-rust-metadata.test.ts
bun run check:scripts-types
node_modules/.bin/vp fmt --check scripts/metadata-query-experiments.ts scripts/metadata-query-experiments.test.ts scripts/benchmark-rust-metadata.ts scripts/benchmark-rust-metadata.test.ts
bun run lint:anti-slop
```

Focused tests/typechecks/formatting passed at the final experiment checkpoint: **18 tests, 173 assertions** across the query and provenance harnesses. Root anti-slop was run throughout; verification checkpoints reported concurrent spacing diagnostics in `scripts/artcraft/content-discover.ts`, `scripts/artcraft/content-rust.ts`, and `packages/features/test/public-share-screen.test.tsx`, outside this task's ownership. Those files were not edited here; integration must rerun the whole-workspace gate. After measurement, the untimed baseline loader was changed to read the same member directly from the checksum-verified original archive rather than require its temporary extraction. All **138** current case/variant SQL outputs were then verified byte-identical to the measured final artifacts; no measured query or input changed.

The separately authorized provenance-only maintenance updates `consumerSourceSnapshot()` to discover the actual owned runtime dependency graph starting from SDK/API/lib. It no longer unconditionally reads retired `packages/core`, and the live-source test no longer assumes four packages. A synthetic focused test covers absent core, an unreferenced leftover directory, a still-declared legacy dependency, cycles, and a missing required dependency (which fails rather than silently omitting evidence). At the recorded check, the actual roots were **client-sdk/api/lib**, all `0.0.0`, covering 44 files with digest `79d1ace271613693a23bbb1ca4a33108a50da68f866305d06c2d0dd934f854ad`.

No new release metadata cohort was run for this discovery change. Workload, timing, budgets and the historical 83-file/four-package source capsule above remain unchanged; future runs record their own three-package/current-client provenance and are explicitly different snapshots. Production SQL, SDK/runtime implementation, root CI/package files, UI and ArtCraft were not edited by this experiment task.

### Subsequent parent source update — not a new measurement

The parent reported independent browser-discovered upload-contention fixes on 2026-11-05: phase-specific safe SQLSTATE diagnostics, the existing four-attempt transaction cap with 10–20/20–40/40–80 ms retry jitter, infrastructure exhaustion returning 503 rather than domain 409, KEY SHARE user-authority guards, NO KEY UPDATE quota locking, and retained explicit FOR UPDATE deletion locking. Migration `0007_upload_admission.sql` adds a private trigger-maintained `pending_uploads` projection in place of the broad live-upload admission scan. These are parent-owned implementation changes, not query-experiment edits or measured listing improvements. See `docs/upload-contention.md` for their bounded functional evidence; parent-reported test results are not additional acceptance runs performed by this experiment.

The evidence identities remain separate:

- **Historical release cohort:** all 7,839 requests belong exclusively to image `sha256:f80c86dcb9aa437fc13fc7fc16f17cad65105ad3e8932e812760d034b5c51c9a` and the historical client/source capsule recorded above. That image predates these contention fixes and other subsequent application changes. Its thresholds, timings, provenance and archived bytes remain immutable; neither current source nor a newer image may be attributed to those observations.
- **SQL-only experiment:** the source/query hashes in this section identify the snapshots used by `qXqYJS`, not a continually current application snapshot. This experiment ran PostgreSQL with migrations 0001/0002 only, not a Rust server image, the transaction retry loop, upload locking or migration 0007. The parent reports production listing/search SQL remains unchanged; that does not make the SQL fixture evidence an application-wide acceptance or performance result.
- **Future application comparison:** record exact current pre/post-optimization image IDs, source manifests and actual SDK/API/lib dependency snapshots, with matching non-query behavior and deployment conditions. Re-run functional, authorization-race and SDK gates and the release benchmark before attributing an application latency change to the selected SQL shapes. No speed claim follows from the new upload-contention fix or its functional tests.

### Bounded production adoption checkpoint — 2026-11-05, runtime verification pending

The parent subsequently authorized implementing only the three selected shapes. `apps/server/src/features/files/service.rs` now builds explicit-parent, owner-trash and no-search/no-parent shared-root statements with contiguous bound parameters. Ordinary root browsing and all library-wide name searches retain the original baseline SQL and original thirteen-value binding order. The shared-root statement retains the measured materialization boundaries; eligible shares are deduplicated without an inventory limit before paging, and descendants are not expanded. No index, migration, API/SDK contract or client workflow was changed.

The existing serializable `run` owner, actor resolution, access requirement, supplied-parent authorization/kind check (including Trash), role loading, projection, breadcrumbs, opaque cursor validation, 100-row cap and lookahead remain in place. This is an implementation checkpoint, **not evidence that the new production queries have executed successfully against PostgreSQL or improved runtime latency**.

Production listing source SHA-256 at the build handoff: `37c40ce7ee50e3f7f3d810f14651ecee259fa73b07fc5b3b31a371e6ef83a4f8`. This file is held unchanged for the parent's coordinated release build. The parent identifies pre-optimization image `sha256:ff0cbe390c3885d40635f5d68616ebdbbdc4c874c0a3790796910fb39746ac06` as having passed release-runtime and actual HTTPS/Nitro SDK gates; **no metadata timing in this document belongs to that image**. A post-adoption image identity and frozen SDK capsule have not yet been captured here. The parent's later disconnect fixes also mean that a simple comparison against that earlier pre-optimization image may contain non-query changes: a query-only attribution still requires matched source/image pairs.

Non-service evidence at this checkpoint:

- Full ordinary Rust gate passed: workspace format check, locked all-target/all-feature Clippy with warnings denied, and **62 tests including a doctest**. All **49 service tests remained ignored**; none of their assertions are claimed passed by this run.
- Two new Rust unit tests exercise the actual statement builder. The matrix covers 768 combinations of scope/parent, authenticated versus anonymous authority, and all six optional-filter presence bits. It checks contiguous used slots, bound values, lookahead, and unchanged baseline SQL/bindings. A separate test checks one-row lookahead and invalid cursor/date handling.
- The exported 768 actual Rust statements were restored to the experiment's parameter numbering and compared with `candidateSql(..., "recommended")`: all matched, ignoring layout whitespace only. This is stronger than checking a copied template, but is still not PostgreSQL parse/execute or HTTP acceptance.
- Scripts typecheck passed; **19 focused tests / 178 assertions** passed; experiment formatter check passed; `contracts:check` passed without generated artifact changes.
- The three owned experiment anti-slop findings were fixed. The latest whole-workspace run reported only two concurrent, out-of-scope spacing diagnostics at `scripts/artcraft/content-delivery.ts:119` and `:124`; that file was left untouched.

Four new explicitly ignored real HTTP/PostgreSQL regressions in `apps/server/tests/support/metadata_listing.rs` cover parent filters/paging/breadcrumbs/strongest roles, 1,201 shared roots with mixed public/account authority and exclusion transitions, owner-only trash groups with preserved parent preconditions, and the direct-root CTE's revocation snapshot race. They compile but **have not run**. The coordinated real-test window must run these plus the existing metadata/high-grant/public-grant/move/revocation tests before acceptance:

```sh
cargo test -p hyori-server --locked --test files_shares -- --ignored --nocapture --test-threads=1
```

The service-free template reproduction is:

```sh
HYORI_LISTING_TEMPLATE_OUTPUT=/absolute/path/to/new-output.json \
  cargo test -p hyori-server --locked --lib listing_tests
bun scripts/metadata-query-experiments.ts --check-production-templates /absolute/path/to/new-output.json
```

Use the repository's Rust build environment for native ICU and bounded build parallelism. Only the explicit `--check-production-templates` mode is service-free; the default experiment command starts its isolated PostgreSQL fixture and is deferred. No Docker fixtures, benchmark cohorts or release builds were started by this adoption task. Real regression gates, matched immutable pre/post images and a frozen SDK/workload capsule remain required. The **2-CPU/4-GB complete-stack target is unbenchmarked**; 150/300 ms remain proposed comparison thresholds, not agreed SLOs or NAS capacity claims.

