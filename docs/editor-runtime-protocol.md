# Native document runtime protocol 2

Status: source contract under integration, **not a built/shipping four-engine capability**. The existing immutable runtime remains manual. This document describes the local same-origin frame protocol; Rust separately owns product operations, authorization, file revisions, output policies, and durable persistence.

The single executable IPC schema owner is `packages/client-sdk/src/features/editors/native-runtime.ts`, publicly exported through `@hyori-cloud/client-sdk/editor-runtime`. Both producer adapters and SDK consumers use those strict runtime schemas and inferred types. Native emitters need golden-schema tests. Do not maintain a second JavaScript wire-schema declaration in vendor patches.

## Binding and bounds

Every message has `type:"<app>:<operation>"`, `protocol:2`, and the exact `version` authorized by the server descriptor. App is one of WordCraft, GridCraft, PdfCraft, or DeckCraft's lowercase identifier. Every event must also come from the exact captured iframe window and exact expected HTTP(S) origin. Payload validation alone does not authorize a sender.

The descriptor must explicitly select `bridge:"hyori-correlated-host-v2"` and `protocol:2`; a version suffix or a frame's self-advertised capability is insufficient. Old official-three and Deck protocol-1 attachments retain their separate manual adapters. New runtime selection must not invalidate a still-authorized session whose exact older version remains in the verified current/legacy catalogue.

IDs are bounded opaque strings. `documentId` and native `revision` are canonical unsigned-64-bit decimal **strings**, preserved exactly, never converted to JavaScript numbers. Equality identifies a snapshot; ordering does not. Native undo, wraparound, and PDF post-save rebasing make ordering unsafe. Native UI draft changes also need observation and acknowledgement guards; the committed-model counter alone is not proof that no new typing exists.

Bytes are nonempty ArrayBuffer/Uint8Array with ordinary ArrayBuffer backing, bounded by the 64-MiB hard ceiling and the server descriptor's smaller input/output ceilings. No transfer may detach the retained recovery snapshot. Names follow the SDK's bounded safe-filename contract. Unknown discriminants, wrong protocols, unexpected fields, malformed identities, unsupported capabilities, and oversized data fail validation rather than being silently stripped.

## Parent commands

All commands carry the common envelope above.

| Operation | Additional payload | Meaning |
| --- | --- | --- |
| `open` | `openId,name,bytes,writable,replacementName,outputFormats,maxBytes` | Fresh attachment input; exactly one initial open. Formats carry extension, document/export kind, and optional smaller byte limit. |
| `request-save` | `requestId,openId,documentId,reason`, optional manual `intentId`, optionally `saveAs:true,name` | Request an engine-produced coherent snapshot. `reason` is `manual` or `automatic`. Explicit copy/export needs a name; automatic requests carry neither a copy nor a native intent. |
| `cancel-intent` | `openId,documentId,intentId` | Fence the matching deferred native action/export job; stale cancellation is a no-op. This does not cancel cloud publication, discard recovery bytes, or mark source clean. |
| `save-result` | Captured tuple plus `status:"saved",fileRevision` | Authoritative durable result for those exact captured bytes. `fileRevision` is the backend revision; captured `revision` remains native. |
| `save-result` | Captured tuple plus `status:"failed"|"conflict"|"read-only"|"access-ended",message` | Preserve snapshot and display failure; never clear native dirty state. |
| `set-theme` | `requestId,theme` | `light`, `dark`, or `system`, applied through the real native theme API. |

The captured tuple is `{requestId,openId,documentId,revision,saveId}`. Acknowledgements must match every field, not only save ID. Save IDs are stable for the retained output, including ambiguous-response retry.

## Native events

All events carry the common envelope.

| Operation | Additional payload | Meaning |
| --- | --- | --- |
| `ready` | `capabilities,maxBytes` | Listening only. Required capabilities are serialize, parsedOpen, documentRevision, durableSaveAck, and theme, each literally true. |
| `opened` | `openId,documentId,revision` | The exact requested document has actually parsed. Only now may the host leave opening state. |
| `dirty` | `openId,documentId,revision,dirty` | Every relevant signature change, including dirty-true to dirty-true, not just boolean transitions. A different native document detaches source replacement. |
| `save-requested` | `openId,documentId,saveAs`, optional `intentId` and explicit `name` | Native Ctrl+S/menu intent, routed through SDK immediate manual admission. Save As includes a chosen name; retained export settings and SaveChanges continuations require an intent ID. Not serialized bytes or a save acknowledgement. |
| `save` | Captured tuple plus `name,bytes,saveAs` | Immutable snapshot produced by the engine after safe native input handling. |
| `saved` | Captured tuple plus `currentRevision,dirty` | Native application of the already durable result. PDF may legitimately advance generation while applying the exact acknowledgement. |
| `save-paused` | Captured tuple plus failure `status,message` | Native presentation of the parent's failure; not an independent workflow authority. |
| `error` | `code,operation,message`, optional `requestId` | Stable code is busy, identity-changed, or serialization-failed; operation is open/save/theme. Do not infer policy from prose. |
| `theme-applied` | `requestId,theme,resolvedTheme` | Matching theme applied through a native UI pass; resolvedTheme is light or dark. |

## Capture, drafts, acknowledgement, and recovery

- One native snapshot remains retained until its durable result is processed. Another serialization cannot overwrite its recovery bytes. An identical repeated request returns the exact retained bytes; another request while occupied gets `busy`.
- Automatic capture preserves focus, caret, selection, and live editing. Do not dispatch synthetic Ctrl+S or manufacture blur/focus. If a coherent snapshot cannot be produced safely during IME or an active draft, return `busy`; a later safe point can retry. Explicit manual Save may settle native input as a user-requested action.
- A model revision is not enough to guard uncommitted typing. Before marking clean, compare the captured document/model revision **and** native draft witness against current state. Newer edits remain dirty even if their engine revision has not advanced yet.
- PDF `mark_saved()` replaces underlying saved bytes and advances generation. Apply it only while the exact capture and draft witness still match; otherwise skip it entirely. Emit the actual post-ack current revision, never overwrite newer edits or present a fabricated clean state.
- A copy or export is not retargeting the open source. Do not change its path, original baseline, source revision, autosave target, or source-clean state. The SDK updates `lastSavedAt` only for a confirmed source replacement. Imported PPTX requires an explicit native copy, not recurring automatic copies.
- A native File New/Open breaks the original source identity. Automatic replacement stops; an explicit copy or fresh attachment is required. A reloaded iframe similarly cannot silently replay an old open over unsaved work.
- Backend failure or conflict retains exact snapshot bytes and ID and pauses automatic saving. Explicit persistence retry reconciles that same attempt; it does not serialize a new version and pretend an uncertain commit never happened.
- Native export jobs retain their real range/layout/active-slide settings inside the frame, keyed by bounded `intentId`. The SDK echoes that ID only on its correlated manual request; invoking the export command recursively or silently regenerating default settings is invalid. Header-initiated copies without a native intent use their explicit ordinary snapshot behavior.
- SaveChanges continuations (New/Open/Close) belong to their exact manual intent and request, never to the next unrelated successful save. Reject/cancel a busy or failed native intent instead of collapsing it into a generic later flush. Cancellation, capture failure, disposal, or a non-saved backend result fences that continuation. A subsequent stable-byte retry may persist data but cannot unexpectedly resume the cancelled action. An ordered cancellation must remain fenced when its later durable acknowledgement is processed.
- Keep existing read-only, revoked-access, close/expiry, immutable history, quota, and stable-ID guarantees. Closing releases a session; it never acknowledges unsaved work.

## Public consumption

```ts
const session = createEditorSession({
  backend: sdkClient.editors.backend({ id, chooseDestination }),
  messages,
  maxBytes: 64 * 1024 * 1024,
  autosave: { idleMs: 750, maxWaitMs: 5000 },
  theme: "system",
});

session.requestSave(); // explicit manual flush, boolean admission
session.requestSave({ saveAs: true, name: "Copy.docx" });
session.setTheme("dark");
// Observe snapshot/status/autosave/pendingSaveCount/lastSavedAt; React owns no save timers.
```

Options and snapshot types are available in source; controller integration, native compilation, real-browser proof, and rollout remain separate gates. `lastSavedAt` is client-observed wall time after durability, not a server timestamp or evidence that later edits are saved. See [measurement plan](editor-performance.md) and [Rust persistence](editor-persistence.md).
