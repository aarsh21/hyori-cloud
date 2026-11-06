# Derived-media latency investigation

Status: follow-up investigation, not an accepted product SLO or a performance-completion claim. The current immutable release/worker browser pass must finish before changing its baseline or starting another Docker experiment.

## Evidence boundary

Opus's scoped readiness report used backend `ff0cbe390c3885d40635f5d68616ebdbbdc4c874c0a3790796910fb39746ac06`, worker `a9797c6aaaf84b2dd1657f758603d03b7c20e117c3d0189187b868b8415406eb`, and frontend digest prefix `c4585571`. It observed a five-second gap between completed jobs and additional ready-to-visible delay under the pending-state refresh policy. Its synthetic 1600×1200 PNG batches exposed scheduling latency; they do not characterize phone libraries, NAS throughput, decoder fidelity or complete-stack capacity. See the readiness/browser artifacts under `/home/aarsh/.t3/userdata/attachments/` and retain their exact source identities when collecting the final report.

Backend `d7585c04bfed12566a21d76d7040c857fb6068bea1c84983c90c940c860eef72` is a distinct later snapshot. Its whole-app HTTP/1.1, HTTP/2 and separate media-latency acceptance are still in progress. Do not move the earlier observations onto that image. The subsequent startup-log-only source correction is also not part of either image.

## Controlled follow-up

After browser cleanup and the read-only council freeze are released:

1. Preserve the completed baseline's full frontend digest, backend/worker IDs, source manifests, workload bytes, timings and host-network log.
2. Compare empty-queue batches of one, eight and 24 identical-workload originals. Record source dimensions, encoded size/hash and format; use only synthetic media. Confirm the preceding batch is terminal before starting the next.
3. Measure upload commit to authoritative `ready`, `ready` to visible tile, total batch completion, decoder/job gaps, metadata reads and bytes. Keep thumbnail requests separate from explicit original-viewer traffic. Record failures and retries rather than treating them as extra passing samples.
4. Hold browser version, CPU/memory limits, storage backing, source bytes and worker recipe constant across matched runs. Record unrelated host load. The earlier host was a Ryzen 5 4600H with about 15 GiB RAM and tmpfs; only the worker was limited to one CPU/512 MiB. That is not the confirmed two-core/four-GB complete-stack target.
5. If the final baseline confirms artificial idle gaps, investigate draining due jobs serially while retaining one decoder request and bounded per-job work. Preserve the idle/error backoff, cancellation, durable claims, retry budget, repair ownership and account-purge fences. Keep decoder work outside product request paths and retryable database transactions.
6. Evaluate pending-state observation separately. Any shorter polling interval must report its extra bounded page-read cost, retain shared Query ownership, stop on failed refresh, avoid background/per-tile waterfalls, and never initiate processing through a read.
7. Re-run real media authorization, replacement/restore, failure/retry, missing-cache repair, cancellation and purge tests before attributing any measured improvement to changed scheduling. Rebuild and identify the affected release image; do not reuse an old image's acceptance label.

## Open conditions

The comparison above is an experimental protocol, not permission to silently increase decoder concurrency, memory or format limits. Candidate latency budgets and representative client/deployment conditions still need agreement before a product-speed claim. A quicker synthetic batch does not establish fairness across owners, sustained backlog throughput, cold-cache behavior, mobile responsiveness or NAS capacity.

Ordinary concurrent uploads also produced occasional declared 503s in the earlier scoped browser report. The current-image browser result must establish whether they persist. If they do, diagnose the failed transaction phase/SQLSTATE and retry/reconciliation semantics independently; neither more decoder parallelism nor silently replaying non-idempotent upload begin is an acceptable substitute for that investigation.
