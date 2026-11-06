# Native hookup handoff — 2026-11-05

Source-only coordination contract, **not a source freeze, build receipt or native acceptance claim**. The canonical wire contract remains `@hyori-cloud/client-sdk/editor-runtime`; do not add app-specific IPC/DTOs.

## Ownership

- Native integration owner: shared `host-protocol.ts`, `host-entry.ts`, `native-types.rs`, `native-clock.rs`, new `native-intent.rs`, new `native-adapter.rs`, shared frame/import glue, `scripts/artcraft/native-methods-patch.ts`, Word/Deck, all marks/palette/build composition.
- Astra: existing `grid-native.rs`, `pdf-native.rs`; new `grid-frame.rs`, `pdf-frame.rs`, `grid-jobs.rs`, `pdf-jobs.rs` under `tooling/artcraft/patches/native-host-v3/`; new `scripts/artcraft/{grid,pdf}-native-hookup.ts` and matching tests. No shared-file edits.
- Per-app patch function: `(source: ReadonlyMap<string, Buffer>) => { files: Map<string, Buffer>, changes: {path: string, before: string | null, after: string}[] }`, with explicit authored inputs if needed. Never mutate retained source trees. Fail on missing/duplicate anchors. Shared composition recomputes the full final-vs-original delta.
- App patch inputs already contain the shared direct-method stage. Grid/PDF job snippets are appended into that app's generated `native_host` module by shared composition; app-specific patchers modify their other UI/web seams. Return exact required source member paths/anchors. Do not modify shared patcher to accomplish it.

## Exact public source inputs

| App | Extracted source root | Archive SHA-256 |
| --- | --- | --- |
| Grid | `/tmp/hyori-gridcraft-source-l0c7r24q/source/gridcraft-0.15.0` | `6bc25221fccaeddd11bb98d31909880719ee9f06ef149520204a368e138c916b` |
| PDF | `/tmp/hyori-pdfcraft-source-rn9tv1mz/source/pdfcraft-0.17.0` | `51f6c4ff4a71809f00a93356d074816e89afe0dfd4f8fcc6be42e59f63c78365` |

Archives are the adjacent `source.tar.gz`. Exact commits and pins remain in `tooling/artcraft/manifest.json`. Tests must hash the archive and use the validated in-memory archive reader. No host vendor code/build scripts. Existing extracted trees are for inspection only.

## Shared native types — actual authored files

`tooling/artcraft/patches/native-host-v3/native-types.rs` remains unchanged. It defines `NativeHostIdentity`, `NativeHostSnapshot` (including its native-only COW guard), `NativeHostFailure`, and `NativeHostSaveReason::{Manual,Automatic}`. Raw model revision is internal; only the shared Rust clock yields wire revisions.

`native-intent.rs` is the exact shared job contract, concatenated into the same UI native-host module after native-types, before app methods/jobs. `NativeHostApp` is the existing per-app alias in grid/pdf-native.rs. Shared composition reexports these types at the UI crate root:

```rust
NativeHostIntent { document_id: u64, save_as: bool, name: Option<String> }
NativeHostIntentFn = Box<dyn Fn(NativeHostIntent)
    -> Result<Option<String>, NativeHostFailure>>;
NativeHostSerializer = Box<dyn Fn(&mut NativeHostApp, u64, &str,
    NativeHostSaveReason) -> Result<NativeHostSnapshot, NativeHostFailure>>;
NativeHostContinuation = Box<dyn FnOnce(&mut NativeHostApp)>;
NativeHostJob { intent_id: String, document_id: u64,
    serializer: Option<NativeHostSerializer>,
    continuation: Option<NativeHostContinuation> }
```

Sink result: `Some(id)` means cloud-delegated; allocate/store the native job under that exact ID. `None` means **explicit local export**, unsupported by the actual open descriptor, and retains the native local export pipeline/options/download. Never fall through to local Save for replacement. `Err` means busy/failure; do not replace an old job or silently run its held action. The shared sink allocates checked, non-reused IDs, rejects when a snapshot/intent is outstanding and evaluates the actual descriptor output formats. Grid currently advertises only `.xlsx`: native PDF export therefore stays local, not cloud XLSX or a fabricated authorized PDF. PDF's non-PDF export UI/settings likewise remain local unless its actual descriptor explicitly authorizes that output.

The app owns at most one job, its exact export options and its held continuation. The frame owns a separate immutable native snapshot. A cloud-owned native Export/SaveChanges MUST have an ID; simple manual Save may use one too. A chooser cancelled before emitting intent clears the app's local job immediately. Preserve chosen ranges/pages/layout/active sheet/slide/settings; do not regenerate defaults, call intercepted `file.save`/`file.export` recursively, or replace a local export with a cloud save.

## Shared web adapter — actual authored trait

Implement `crate::native_host::NativeHostAdapter` in each `grid-frame.rs`/`pdf-frame.rs`. Exact trait lives in `native-adapter.rs`, concatenated into the new web `native_host.rs` shared module. That module imports/reexports `egui` and UI-root native types. The per-app web adapter module implements it for the UI app and is registered by the app-specific hookup patch.

- `host_identity() -> Option<NativeHostIdentity>`: current native model, None for no document; never fabricate a wire document ID.
- `host_pending_input() -> bool`: live input/drafts/composition. Avoid classifying a nonediting SaveChanges continuation itself as a document draft. Automatic capture preserves-or-busy; manual may settle using native rules.
- `host_install_intents(sink: NativeHostIntentFn)`: install a narrow native callback; do not retain old boolean host-save callbacks that mark saved on postMessage.
- `host_open(name, bytes) -> Result<Option<NativeHostIdentity>, NativeHostFailure>` and `host_poll_open()` of same result: Some only after the **requested** input parsed/inserted. None means correlated interactive/password open pending. Track that specific pending open; a newly active unrelated native document is not its acknowledgement. Detect cancellation/failure. Existing busy-on-password helpers need adaptation, not an acknowledgement of the old file.
- `host_capture(document_id, name, reason, intent_id: Option<&str>) -> Result<NativeHostSnapshot, NativeHostFailure>`: exact matching private job/format when ID provided; default snapshot when None (Hyori header copy). Missing/cancelled ID must fail, never default-export. Destination rename may change the basename but not the chosen export extension/options.
- `host_acknowledge(snapshot, save_as) -> Result<bool, NativeHostFailure>`: normalize Grid bool to Ok(bool), retain PDF Result. Exact raw identity + COW witness + no newer draft. Copy/local export never cleans or retargets original. PDF exact PRE-apply guard before mark_saved, legitimate POST-generation bump reported by shared clock.
- `host_cancel_intent(id)`: drop only the matching job/held action. Do not touch captured snapshot, durability uncertainty, source baseline or current dirty flag.
- `host_finish_intent(id, exact_replacement)`: called AFTER matching saved/currentRevision publication. Take/drop matching job in all cases. Run held action only if exact_replacement=true, never after failure/cancel/conflict, newer input or copy. A retry of captured bytes cannot revive a cancelled action.
- `host_theme(preference, resolved_dark) -> Result<(), NativeHostFailure>`: actual Grid/PDF native preference API, not wrapper styling. Shared frame checks/applies native chrome through the UI pass; System follows browser changes. Never change document content/typography.

Shared frame provides install/run lifecycle and all JS IPC, observes the tested clock from real raw_input_hook once per input batch, observes after UI and after manual settlement, retains snapshot/wire tuple, and drains cancellation/failure BEFORE ack. Astra owns app-specific frame hookup calls and adapter only.

Concrete source now exists in `native-frame.rs` and `native-imports.rs`, **not compiled yet**. `scripts/artcraft/native-frame-patch.ts` adds the shared web module, tested clock and bundled entry without changing Cargo versions/locks. It defines `crate::native_host::NATIVE_ARTIFACT_VERSION`; pass that constant, NOT `env!(CARGO_PKG_VERSION)`, to prepare. Upstream crate versions remain attribution/dependency identities, while modified artifact/About/host versions are explicit.

The nongeneric `NativeHostFrame` exposes:

```text
prepare(app:&str,version:&str) -> Result<bool,NativeHostFailure> [static, pre-runner]
new(ctx:&egui::Context,app:&mut impl NativeHostAdapter)
  -> Result<Option<Self>,NativeHostFailure> [after app construction]
ready() -> Result<(),NativeHostFailure> [static, only after runner success]
failed(message:&str) -> Result<(),NativeHostFailure> [static]
note_input(&mut self,app:&impl NativeHostAdapter,raw:&egui::RawInput)
  -> Result<(),NativeHostFailure> [BEFORE app.raw_input_hook]
before_logic(&mut self,app:&mut impl NativeHostAdapter,ctx:&egui::Context)
  -> Result<(),NativeHostFailure> [BEFORE app.logic]
after_logic(same arguments) -> Result<(),NativeHostFailure> [AFTER app.logic]
after_ui(same arguments) -> Result<(),NativeHostFailure> [AFTER app.ui]
```

Store `Option<NativeHostFrame>` on the web owner. Grid uses its existing WebShell; PDF uses a web-only `NativeWebApp` wrapper at `apps/pdfcraft-web/src/native_frame.rs`, forwarding the existing eframe methods including save. Do not embed the frame into the UI crate. Both app-specific adapter modules live at `apps/<app>-web/src/native_frame.rs`. Shared module is `apps/<app>-web/src/native_host.rs`, clock submodule `native_host/clock.rs`, imports consume `/hyori-native-host.js`.

`patchNativeMethods` now accepts optional `intents?: Buffer` and `jobs?: Buffer`, in addition to `types`/`methods`. It concatenates types, intents, methods, jobs in that order and reexports shared job types when intents are present; jobs without intents are rejected. Original default method-stage behavior is unchanged.

## Existing JS exports (actual source, canonical validation)

`host-entry.ts` currently exports:

```text
hostRequested() -> boolean
prepareHost(app, version) -> boolean
attachHostRepaint(callback)
hostReady(); hostFailed(message); hostDetached(message)
hostTakeOpen() -> command | null
hostOpened(openId, documentId, revision)
hostOpenFailed(openId, message)
hostObserved(documentId, revision, dirty)
hostSaveRequested(documentId, saveAs, name?, intentId?) -> boolean
hostTakeSaveRequest() -> { requestId, openId, documentId, reason, intentId?, saveAs, name } | null
hostSerialized(requestId, documentId, revision, name, Uint8Array, saveAs) -> saveId
hostSerializationFailed(requestId, code, message)
hostTakeCancellation() -> canonical cancel-intent | null
hostTakeFailure() -> canonical negative save-result + private intentId? | null
hostTakeAcknowledgement() -> canonical positive save-result + private
    { name, saveAs, intentId?, continuationCancelled } | null
hostAcknowledged(beforeDocumentId|null, beforeRevision,
    currentDocumentId|null, currentRevision, dirty)
hostTakeThemeRequest() -> {requestId, theme} | null
hostThemeApplied(requestId, theme, resolvedTheme)
```

All u64 values cross as decimal strings. `reason` is required. `requestId` privately binds the job, not an extra public save/ack tuple field. Acknowledgement take is blocked while a cancellation/failure fence awaits consumption; it does not return another 64 MiB byte copy. Cancellation and negative results retain exact recovery bytes. Post-ack active signature suppresses duplicate false observation after PDF generation bump; every later clock change, including dirty:false draft cancellation, still emits.

## Acceptance and exclusions

Preserve all old native local export capabilities/settings and legal/lock/source bytes outside explicit patches. Cover queued drafts/busy, repeated dirty revisions, exact options, cancelled chooser, SaveChanges success, cancellation/failure then persisted retry without stale continuation, newer edit/draft versus old ack, native New/Open detach, PDF post-ack generation and native theme. Tests here are source/unit evidence; only a later coordinated restricted build and real browser lifecycle prove the adapter. No full builds, deployment, commits, new agents or edits to old bb6/.2 evidence before source freeze.
