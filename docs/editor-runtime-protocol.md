# Native document runtime protocol 3

Status: source contract under integration, **not a built/shipping four-engine capability**. The existing immutable runtime remains manual. This document describes the local frame protocol; Rust separately owns product operations, authorization, file revisions, output policies, and durable persistence.

## Sandboxed frame (protocol 3)

Protocol 3 is protocol 2's message set in a sandboxed frame. The host creates the editor frame with exactly `sandbox="allow-scripts allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads"`: no `allow-same-origin` and no top navigation of any kind. The editor document therefore has an opaque origin. It cannot reach the host page's DOM or storage, its own `localStorage`, IndexedDB or cookies are refused, and its requests to `/api/*` go out cross-site without the `SameSite=Strict` session and with unreadable replies. What it receives is what the bridge deliberately hands it: one document's bytes, save results and theme requests.

- Every frame message carries origin `"null"`, which identifies nothing. The host accepts a message only from the exact window it captured before navigating the frame, and posts only to that window with target `"*"`. The host page's own `frame-src 'self'` keeps that window on Hyori's origin; a frame that navigates itself, even on that origin, is a new document and never receives the document again.
- The frame bridge requires `window.origin === "null"` and refuses to start otherwise, so a protocol 3 runtime never runs with the host's authority.
- **Every `/artcraft` response is sandboxed too**, not only the host's frame. Its Content-Security-Policy starts with the same `sandbox` tokens (`scripts/editor-csp.ts`), so an editor page has an opaque origin however it is reached: in the frame, opened by the frame as a popup (which `allow-popups-to-escape-sandbox` would otherwise leave unsandboxed), followed from a link on any site, or typed in. Such a page sends no session, reads no host storage, and its requests to `/api/*` are refused.
- **No URL intake.** Upstream PdfCraft's standalone page opens `?file=<url>` with `window.fetch`. Hyori's build removes that intake (one line in `apps/pdfcraft-web/src/main.rs`, `scripts/artcraft/pdf-native-hookup.ts`). The pinned Word, Grid and Deck web apps read only `host`, `webgl`, `sample`, `author` and `chrome`, and fetch nothing they are handed.
- Because scripts and WASM in an opaque-origin document load with CORS, the gateway sends `Access-Control-Allow-Origin: *` on `/artcraft/*`. Those files are public static assets.
- **Engine handoff.** Chromium bypasses the HTTP cache for an opaque-origin document's subresources, so a sandboxed frame would download its 23–50 MB engine on every open. A protocol 3 descriptor therefore names its engine (`engine: {url, sha256, bytes}`, taken by the server from the verified inventory). The host starts fetching it from its own cache as soon as the descriptor arrives and checks its size and SHA-256. The frame's loader sends one `engine-request` that names nothing, and the host answers with one `engine` command: the transferred bytes, or `null` to load them the ordinary way. A second request means the frame started over: the session stops, as for a second `ready`, and the frame gets nothing more. The frame never chooses what the host fetches.
- **Print (Word, Grid).** A sandboxed page can't show a PDF: not in a child frame, and not in a tab it opens, because that tab inherits the page's own sandbox and Chromium's viewer refuses it. Hosted Word and Grid print therefore downloads the generated PDF as `Print.pdf`, and the person prints it from their PDF viewer. Nothing the frame produces is rendered in Hyori's origin or any other. Before it hands anything over, the bridge (`hostShowPdf`) requires the `%PDF-` signature and at most 64 MiB, and it sets the type to `application/pdf` itself. PdfCraft prints its own window (`allow-modals`), and Deck downloads its PDF.
- **Why each sandbox token stays.** `allow-scripts` runs the engine. `allow-downloads` carries print, Deck's PDF and exports. `allow-modals` lets PdfCraft print its own window and the editors confirm before discarding work. `allow-popups` opens a document's hyperlinks, and `allow-popups-to-escape-sandbox` lets those pages work normally (sign-in, storage) instead of inheriting the editor's sandbox. Since every `/artcraft` response is sandboxed by its own header, escaping the frame's sandbox gives no editor page Hyori's authority; other Hyori pages a popup can reach give the frame no more than any external site has (see `docs/editor-deployment.md`).
- **Preferences don't persist.** `localStorage` is refused, so preferences last only for the open document. Word loses `wordcraft.ui`: theme and interface size (Hyori's theme still applies per open), ribbon tab and collapsed state, quick access toolbar, recent files, symbols, colours and fonts, navigation and styles pane layout, author name (Hyori supplies it per open), language, editing preferences (`wordcraft_engine::Prefs`), read-aloud rate and citation skipping, and key tips. Grid loses `gridcraft.ui`: theme, ribbon tab and collapsed state, formula bar and status bar, animations, autocomplete, autosave, recent files, language and interface scale. It also loses `gridcraft.prefs`: Enter direction, autocomplete, user name, default font and size, sheets in a new workbook, user dictionary, formula bar, status bar statistics and recent functions. PDF and Deck keep nothing there.
- Protocol 2 runtimes (`hyori-correlated-host-v2`) refuse an opaque-origin frame. The SDK fails their sessions immediately with reason `runtime-outdated`, and the editor screen tells the person their administrator must update the editor. The backend logs a warning at startup for every current runtime below protocol 3, and `scripts/editor-csp.ts` refuses to print a gateway policy for one.

The single executable IPC schema owner is `packages/client-sdk/src/features/editors/native-runtime.ts`, publicly exported through `@hyori-cloud/client-sdk/editor-runtime`. Both producer adapters and SDK consumers use those strict runtime schemas and inferred types. Native emitters need golden-schema tests. Do not maintain a second JavaScript wire-schema declaration in vendor patches.

## Binding and bounds

Every message has `type:"<app>:<operation>"`, `protocol:3`, and the exact `version` authorized by the server descriptor. App is one of WordCraft, GridCraft, PdfCraft, or DeckCraft's lowercase identifier. Every event must also come from the exact captured iframe window, with the opaque origin `"null"`. Payload validation alone does not authorize a sender.

The descriptor must explicitly select `bridge:"hyori-correlated-host-v3"` and `protocol:3`; a version suffix or a frame's self-advertised capability is insufficient. Old official-three and Deck protocol-1 attachments retain their separate manual adapters. New runtime selection must not invalidate a still-authorized session whose exact older version remains in the verified current/legacy catalogue.

IDs are bounded opaque strings. `documentId` and native `revision` are canonical unsigned-64-bit decimal **strings**, preserved exactly, never converted to JavaScript numbers. Equality identifies a snapshot; ordering does not. Native undo, wraparound, and PDF post-save rebasing make ordering unsafe. Native UI draft changes also need observation and acknowledgement guards; the committed-model counter alone is not proof that no new typing exists.

Bytes are nonempty ArrayBuffer/Uint8Array with ordinary ArrayBuffer backing, bounded by the 64-MiB hard ceiling and the server descriptor's smaller input/output ceilings. No transfer may detach the retained recovery snapshot. Names follow the SDK's bounded safe-filename contract. Unknown discriminants, wrong protocols, unexpected fields, malformed identities, unsupported capabilities, and oversized data fail validation rather than being silently stripped.

## Parent commands

All commands carry the common envelope above.

| Operation       | Additional payload                                                                              | Meaning                                                                                                                                                                            |
| --------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `open`          | `openId,name,bytes,writable,replacementName,outputFormats,maxBytes`                             | Fresh attachment input; exactly one initial open. Formats carry extension, document/export kind, and optional smaller byte limit.                                                  |
| `request-save`  | `requestId,openId,documentId,reason`, optional manual `intentId`, optionally `saveAs:true,name` | Request an engine-produced coherent snapshot. `reason` is `manual` or `automatic`. Explicit copy/export needs a name; automatic requests carry neither a copy nor a native intent. |
| `cancel-intent` | `openId,documentId,intentId`                                                                    | Fence the matching deferred native action/export job; stale cancellation is a no-op. This does not cancel cloud publication, discard recovery bytes, or mark source clean.         |
| `save-result`   | Captured tuple plus `status:"saved",fileRevision`                                               | Authoritative durable result for those exact captured bytes. `fileRevision` is the backend revision; captured `revision` remains native.                                           |
| `save-result`   | Captured tuple plus `status:"failed"                                                            | "conflict"                                                                                                                                                                         | "read-only" | "access-ended",message` | Preserve snapshot and display failure; never clear native dirty state. |
| `set-theme`     | `requestId,theme`                                                                               | `light`, `dark`, or `system`, applied through the real native theme API.                                                                                                           |

The captured tuple is `{requestId,openId,documentId,revision,saveId}`. Acknowledgements must match every field, not only save ID. Save IDs are stable for the retained output, including ambiguous-response retry.

## Native events

All events carry the common envelope.

| Operation        | Additional payload                                                  | Meaning                                                                                                                                                                                                                                |
| ---------------- | ------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ready`          | `capabilities,maxBytes`                                             | Listening only. Required capabilities are serialize, parsedOpen, documentRevision, durableSaveAck, and theme, each literally true.                                                                                                     |
| `opened`         | `openId,documentId,revision`                                        | The exact requested document has actually parsed. Only now may the host leave opening state.                                                                                                                                           |
| `dirty`          | `openId,documentId,revision,dirty`                                  | Every relevant signature change, including dirty-true to dirty-true, not just boolean transitions. A different native document detaches source replacement.                                                                            |
| `save-requested` | `openId,documentId,saveAs`, optional `intentId` and explicit `name` | Native Ctrl+S/menu intent, routed through SDK immediate manual admission. Save As includes a chosen name; retained export settings and SaveChanges continuations require an intent ID. Not serialized bytes or a save acknowledgement. |
| `save`           | Captured tuple plus `name,bytes,saveAs`                             | Immutable snapshot produced by the engine after safe native input handling.                                                                                                                                                            |
| `saved`          | Captured tuple plus `currentRevision,dirty`                         | Native application of the already durable result. PDF may legitimately advance generation while applying the exact acknowledgement.                                                                                                    |
| `save-paused`    | Captured tuple plus failure `status,message`                        | Native presentation of the parent's failure; not an independent workflow authority.                                                                                                                                                    |
| `error`          | `code,operation,message`, optional `requestId`                      | Stable code is busy, identity-changed, or serialization-failed; operation is open/save/theme. Do not infer policy from prose.                                                                                                          |
| `theme-applied`  | `requestId,theme,resolvedTheme`                                     | Matching theme applied through a native UI pass; resolvedTheme is light or dark.                                                                                                                                                       |

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
