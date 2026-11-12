# Rust architecture council

Status: Round 3 complete; **Round 4 is in progress** with fresh read-only Astra High Fast and Sol High reviewers. Existing scores belong to their reviewed snapshots, not later code. Upload contention/admission/publication recovery and request-disconnect fixes now have separate real-service regressions, and the coherent release passed runtime/HTTPS-Nitro SDK gates. Opus's real-worker browser acceptance is separate and ongoing. Editor WASM/cloud integration, redistribution and whole-product/operational acceptance remain open. No 10/10 or production-readiness claim has been made. See [upload contention and publication recovery](upload-contention.md).

## Request and review contract

The owner requested Apollo Rust best practices and adversarial review by Astra High Fast and Sol High, iterating on verified issues toward 10/10 architecture and Rust-code scores. Reviewers score independently; the target is not permission to inflate scores, hide findings, suppress checks or redefine incomplete product features as delivered.

Review the current Rust code and cross-language architecture in `apps/server`, `crates/storage`, the contract exporter/generator, public API/SDK boundary, web proxy, migrations, tests, and Rust packaging. These include untracked/new source files, not only `git diff`. Apply `AGENTS.md`, the Fernando architecture contract and `.claude/skills/rust-best-practices`. Record precise source evidence, failure scenarios, verification gaps and performance assumptions; distinguish correctness/security/durability findings from style preferences.

Reviews are read-only and run against a frozen worktree snapshot. Each reviewer reports separate architecture and Rust-code scores out of ten, blockers, and conditions for improvement. A fresh scored pass after fixes is a new round. A current-code score does not prove complete v1 delivery or production readiness; [rust-rewrite.md](rust-rewrite.md) owns the still-open integration and product checklist.

## Round 4 frozen review checkpoint

Reviewed runtime/API/SDK/composition input manifest: `/tmp/hyori-council-round4-keNAdI/source-sha256.txt`, SHA-256 `ab8f78cf1ca547a6027ae143afd45e34c67687737f2f3c45319e0933818d718d`. Both independent reviewers check it before and after reading. UI/browser fixtures and ArtCraft research are outside this freeze; the council does not review UI design or issue legal clearance. No Docker, web build or browser activity is permitted during Opus's exclusive network window.

Pre-review gates: strict locked Rust formatting/all-target/all-feature Clippy/ordinary tests/rustdoc, 120 SDK tests/types/public compile, generated contracts and compiled Query evolution, public boundaries, physical offline SDK/API/lib consumer artifacts, and six native proxy tests pass. Separate actual-service evidence covers six disconnect regressions, eight affected upload/contention/deletion tests, and ten metadata/permissions tests. Image `d7585c04…` passed production runtime and verified HTTPS/Nitro SDK gates; the only later runtime-source difference is correction of an obsolete startup log. Compose's 150-second stop grace has render-only invariant coverage, not persistent deployment acceptance. Current whole-tree anti-slop findings belong to active ArtCraft research tooling and remain reported rather than suppressed.

Architecture and Rust-code scores will be recorded only after each review completes. Unfinished editor/browser/performance/operational gates remain distinct from these scores. No score improvement is inferred from passing tests.

## Baseline evidence

The following baseline belongs to the earlier auth/metadata rounds. Later upload, UI and fix evidence is recorded under its round below; concurrent SDK/editor work still requires a combined final gate.

- No pull request exists for the current branch; no outstanding PR comments were found.
- Project-local Rust skill installed with telemetry and remote audit requests disabled; upstream source hash/license recorded in `.agents/skills/UPSTREAM.md`.
- Anti-slop lint and scripts/tooling typechecks pass.
- Actual Rust-derived contracts pass byte-exact checking, public SDK regressions and the compiled Rust-to-SDK/Query evolution fixture.
- Parent's post-fix workspace checks pass: formatting/lint, package typechecks and production web build, scripts/tooling typechecks, public package boundaries, byte-exact contracts and ten generator tests. The build retains a large-client-chunk warning.
- Root functional tests pass: 142 passed, one live-service skip; the nested mounted feature suite has 116 passed. React test-renderer deprecation and JSDOM script/search warnings remain.
- Query gate passes, including public consumption/type checks, app-runtime tests and actual compiled Rust-to-SDK evolution.
- Strict workspace Rust formatting, locked all-target/all-feature Clippy and ordinary tests/rustdoc pass. Nine server Docker tests and five storage Docker tests are explicitly ignored in the ordinary run and separately executed below.
- Parent explicitly ran all nine real PostgreSQL tests: Unicode/bootstrap boundaries, Files/Sharing parity, 1,001 incoming shares, parallel public grants across two independent HTTP servers, snapshot revocation/move races, bounded transaction retries, auth lifecycle and migration refusal; all pass.
- Parent explicitly ran all five real pinned RustFS tests; all pass. The multipart-prefix limitation is characterized rather than treated as successful owner cleanup. Unit/fault/validation tests and compile-only rustdoc also pass.
- Parent reran the actual compiled Rust/PostgreSQL -> streaming web proxy -> public vanilla SDK auth/invite/private-folder/sharing/revocation/trash/logout/outage/process-restart lifecycle after all fixes; passed. This still does not exercise product upload or binary route integration.
- No real-browser performance, complete-stack capacity or ArtCraft format-fidelity evidence exists yet. Metadata and storage adapters are not a completed upload/purge/media pipeline.

## Rounds

Rounds completed: 3.

| Delegate        | Round 1 architecture | Round 1 Rust code | Round 2 architecture | Round 2 Rust code | Round 3 architecture | Round 3 Rust code |
| --------------- | -------------------- | ----------------- | -------------------- | ----------------- | -------------------- | ----------------- |
| Astra High Fast | 8/10                 | 8/10              | 9/10                 | 9/10              | 9/10                 | 8.5/10            |
| Sol High        | 8.5/10               | 8.5/10            | 9/10                 | 9/10              | 8.8/10               | 9/10              |

### Verified findings and fix status

1. **Incoming-grant lockout (Astra P1):** replaced full incoming-grant enumeration with SQL-scoped listing/search, one page-role aggregation query and resource/ancestor-scoped authorization. The real regression with 1,001 direct shares across deep trees passes for owned listing/mutations and shared discovery; neither truncation nor a raised recipient-wide limit is the fix.
2. **Concurrent grant-cookie loss (both P2):** independent server-owned per-share cookies replace aggregate-cookie writes. Bounded credential parsing and SQL-selected authority retain at most sixteen active grants. Parallel resolves from empty/existing cookie jars against two independent HTTP servers pass; sequential retention and refreshed-cookie races are covered. Concurrent additions at capacity can temporarily leave extra cookie names, not extra authority; unrelated below-capacity responses do not delete a cookie another tab may refresh.
3. **Clean-cache evolution/CI failure (Astra P2):** replaced the temporary unlocked Rust package with a checked-in workspace example using `--locked --offline`. CI now prepares the pinned toolchain/native dependencies and `cargo fetch --locked` before offline architecture checks, and adds strict Rust/unit/rustdoc/real-service/contract-drift gates. Warm evolution, scripts/tooling checks, and an actual empty-`CARGO_HOME` locked fetch followed by offline Rust compilation and SDK/Query evolution all pass. This proves fresh Cargo-cache preparation on the current host, not a remote Ubuntu CI run; remote CI has not been run.
4. **Unicode password policy mismatch (Astra P3):** feature-owned code-point limits are shared with the owned adapter, which validates those limits before calling Better Auth; its UTF-16 maximum is configured to accommodate every allowed Unicode scalar sequence. Real account creation/login for 513 and 1,024 supplementary characters passes, and 1,025 is rejected.
5. **Unsubmit-able configured setup token (Sol P2):** configuration and the public schema now share token character bounds. Overlong tokens fail configuration rather than leaving a ready but uninitializable instance. Boundary schema/configuration and actual maximum-length bootstrap tests pass.

Both reviewers withdrew a duplicate-account failure hypothesis after actual 200/409 results. It is not an outstanding finding. Neither reviewer recommended generic trait/typestate rewrites or a silent RustFS upgrade.

### Round 2 disposition

Both independent reviewers scored the implemented slice 9/10 for architecture and Rust code. Astra found no new confirmed code-level defect and is satisfied to advance without abstraction churn. Sol confirmed permanent growth of expired sessions, grants and limiter buckets; Astra also identified cleanup as necessary for long-running deployment. This is one verified resource-lifecycle finding, not a disagreement about whether cleanup is required.

The fix adds a runtime-owned authentication maintenance loop, immediate startup pass and 30-second cadence, at most 256 expired rows per table per pass, database-time expiry predicates and `FOR UPDATE SKIP LOCKED` for concurrent workers. It also reclaims expired invites. The limiter and cleanup share their window duration. Shutdown stops maintenance before closing the pool; failed transactions leave records for the next pass. PostgreSQL regressions pass for bounded batches/restart, retained live authority, locked limiter refreshes, independent workers and rollback when a later table is unavailable. The actual Rust executable's SDK lifecycle also verifies startup cleanup of all four record types and clean shutdown. Post-fix strict workspace Rust checks, all eleven PostgreSQL tests, all five RustFS tests, scripts typecheck and byte-exact contracts pass; no post-fix review score is inferred.

Both reviewers require actual release-container/environment evidence and representative release-mode query plans/measurements before deployment or speed claims. Whole-product upload/quota/binary/Photos/admin-purge/editor completion remains separate; remote CI has not been run.

The parent built the auth/metadata-plus-cleanup release image locally with the checked-in multi-stage Dockerfile. Image ID: `sha256:f0dd155518880e406085d7b52486eb6d0d7df31f94c61a0c6321e38aa28fd73a`. The compiler reported an optimized release build of 3m 07s on this host; this is build evidence, not application-performance evidence. `bun run test:rust-image <local-image-tag>` drives a unique PostgreSQL/network/server fixture through the public SDK and real streaming proxy. It passes with UID 10001, a read-only root filesystem, dropped capabilities, production Secure/HttpOnly cookies, real setup/folder/logout, clean shutdown and persisted sessions/metadata after restart. Docker's random published port is rediscovered on restart. Fixtures remove only their own containers/volumes/network. TLS termination is not exercised. This image predates upload/storage integration; the later image evidence below supersedes it for the upload slice.

### Round 3 disposition

The review expanded to the implemented durable upload/download lifecycle. Astra independently ran 17 generator/proxy tests, 11 storage-failure tests and a real PostgreSQL grant-continuity reproduction; Sol ran formatting, contract drift, seven proxy tests and an independent reproduction. Both confirmed one P2: resolving the same public link replaced its HttpOnly grant and stranded anonymous uploads bound to the old digest. Neither found a committed-byte-loss, duplicate-accounting or authorization-bypass defect. Scores above are genuine and were not inferred upward after fixes.

The parent now reuses an existing valid presented credential for that share, preserves its fixed database expiry, and returns a cookie with only its remaining lifetime. Re-resolution updates recency for bounded retention, not token ownership or expiry. Expired credentials require authorization again, and a separate holder's credential cannot access another holder's upload. No upload-policy widening was introduced.

A real PostgreSQL/pinned-RustFS regression passes across independent HTTP instances, including re-resolve between storage ingest and acknowledgement, checkpoint reconstruction on a new instance, re-resolve between storage completion and metadata publication, cancellation, unrelated-holder denial, unchanged expiry, no extra grant rows, expired-credential denial and revocation. The existing multi-process sixteen-grant retention/concurrency regression also passes. Post-fix workspace formatting, strict locked Clippy, ordinary Rust/rustdoc tests and byte-exact contract checks pass. The whole-repo anti-slop rerun currently encounters active ArtCraft spacing diagnostics outside these changed files; they are not suppressed.

Before this continuity fix, the parent independently verified the real Rust-to-proxy-to-public-SDK multipart resume/restart, download digest, zero-byte, retry/cancel, lost completion replay, replacement/history/restore and distinct-object quota lifecycle, plus the original metadata/auth/cleanup lifecycle. The upload-containing release image also passes the expanded image harness with actual PostgreSQL and pinned RustFS, multipart transfer, SHA-256-verified bytes after restart, production cookies and non-root/read-only execution. That built image predates the continuity fix; final deployment needs a current-source rebuild.

The Opus UI pass independently passes 133 mounted tests, 143 other functional tests (one live-service skip), source-file checks and architecture/React Compiler lint. Local private React Doctor reports five existing warnings, separately from functional evidence. Replacement checkpoint intent still needs first-class SDK ownership and then Opus integration; a temporary feature-level decorator is not final acceptance. Photos/inline previews, admin account purge, editors, actual browser/TLS/remote CI acceptance and representative resource characterization remain open.
