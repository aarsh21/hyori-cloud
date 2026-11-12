import { EditorApp, EditorDocument as ProductEditorDocument } from "@hyori-cloud/api/rpc";
import type { EditorIntent, EditorPrepareSave, EditorSaved } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";

import type { NativeHostCommand, NativeTheme } from "#client-sdk/features/editors/native-runtime";

// Rust owns public descriptors. The remaining contracts describe local byte/frame capabilities.
export type ArtCraftApp = typeof EditorApp.Type;

export const BridgedArtCraftApp = EditorApp;

export type BridgedArtCraftApp = typeof BridgedArtCraftApp.Type;

export { EditorName } from "#client-sdk/features/editors/native-runtime";

export const EditorDocument = ProductEditorDocument;

export type EditorDocument = typeof EditorDocument.Type;

export interface EditorOutput {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  intent: EditorIntent;
}

/** Why a session stopped. `failed` reasons happen while opening; the rest end a working session. */
export type EditorStopReason =
  | "unsupported"
  | "session-limit"
  | "unavailable"
  | "unreadable"
  | "network"
  | "timeout"
  | "crashed"
  | "access-revoked"
  | "session-ended"
  | "editor-updated"
  /** The server's editor runtime predates sandboxed frames; an administrator must rebuild it. */
  | "runtime-outdated";

export type EditorSaveResult =
  | Pick<EditorSaved, "status" | "revision">
  | { status: "conflict"; message: string }
  | { status: "read-only"; message: string }
  | {
      status: "access-ended";
      message: string;
      reason?: Extract<EditorStopReason, "access-revoked" | "session-ended" | "editor-updated">;
    }
  /** Nothing was written: the person declined to choose a destination. */
  | { status: "cancelled"; message: string }
  | { status: "failed"; message: string; retryable?: boolean };

export interface EditorBackendPort {
  open(options: { signal: AbortSignal }): Promise<EditorDocument>;
  /** Retire this bound resource; unresolved saves must retain their server reconciliation state. */
  close?(): Promise<void>;
  download(document: EditorDocument, options: { signal: AbortSignal }): Promise<Uint8Array>;
  // A non-replacement output must never replace the source. The binding must obtain any
  // required destination/user choice, or return cancelled; it cannot silently reinterpret intent.
  // The caller retains output.bytes for retry: never mutate or transfer them, copy what you keep.
  save(
    // Every retry keeps its save ID; the server durably deduplicates the operation.
    input: Pick<EditorPrepareSave, "sessionId" | "expectedRevision" | "saveId" | "saveMode"> & {
      output: EditorOutput;
    },
    options: { signal: AbortSignal },
  ): Promise<EditorSaveResult>;
}

export interface EditorMessageEvent {
  origin: string;
  source: unknown;
  data: unknown;
}

export type EditorHostMessage =
  | NativeHostCommand
  | { type: string; name: string; bytes: Uint8Array<ArrayBuffer> }
  | {
      type: "deckcraft:open";
      protocol: 1;
      version: string;
      openId: string;
      name: string;
      bytes: Uint8Array<ArrayBuffer>;
      maxBytes: number;
      writable: boolean;
      replacementName: string | null;
      outputFormats: EditorDocument["outputFormats"];
    }
  | ({
      type: "deckcraft:save-result";
      protocol: 1;
      version: string;
      saveId: string;
    } & EditorSaveResult);

export interface EditorMessagePort {
  origin: string;
  source: object;
  subscribe(listener: (event: EditorMessageEvent) => void): () => void;
  /** `transfer` hands exclusively owned buffers to the frame instead of cloning them. */
  post(message: EditorHostMessage, targetOrigin: string, transfer?: ArrayBuffer[]): void;
}

/**
 * Loads the engine a descriptor names from the host's own cache, refusing bytes that differ from
 * the descriptor. The sandboxed frame can't use the HTTP cache, so the host hands it over.
 */
export interface EditorEnginePort {
  load(
    engine: NonNullable<EditorDocument["engine"]>,
    options: { signal: AbortSignal },
  ): Promise<ArrayBuffer>;
}

/** Whether the host page is hidden. Hidden frames run on throttled timers, so waits stretch. */
export interface EditorVisibilityPort {
  hidden(): boolean;
  subscribe(listener: () => void): () => void;
}

export type EditorStatus =
  | "opening"
  | "editing"
  | "saving"
  | "save-failed"
  | "conflict"
  | "read-only"
  | "access-ended"
  | "failed"
  | "disposed";

export const EditorAutosave = Schema.Union(
  Schema.Struct({
    status: Schema.Literal("disabled"),
    reason: Schema.Literal("not-enabled", "unsupported", "read-only", "copy-required"),
  }),
  Schema.Struct({ status: Schema.Literal("idle", "scheduled", "serializing") }),
  Schema.Struct({ status: Schema.Literal("waiting"), reason: Schema.Literal("native-busy") }),
  Schema.Struct({
    status: Schema.Literal("paused"),
    reason: Schema.Literal("save-failed", "conflict", "access-ended", "serialization-failed"),
  }),
);

export type EditorAutosave = typeof EditorAutosave.Type;

export interface EditorSessionOptions {
  backend: EditorBackendPort;
  messages: EditorMessagePort;
  maxBytes: number;
  readyTimeoutMs?: number;
  autosave?: { idleMs: number; maxWaitMs: number };
  theme?: NativeTheme;
  visibility?: EditorVisibilityPort;
  /** Signals restored connectivity; retries still share the snapshot's bounded attempt budget. */
  connectivity?: { subscribe(listener: () => void): () => void };
  /** Hands a protocol 3 frame the engine its descriptor names. */
  engine?: EditorEnginePort;
}

export interface EditorSnapshot {
  status: EditorStatus;
  document: EditorDocument | null;
  hasUnsavedChanges: boolean;
  pendingSaveCount: number;
  /** The output a pending save is for: a copy that failed can be given up on, a source can't. */
  pendingOutput: Pick<EditorOutput, "name" | "intent"> | null;
  /** Outputs getRecoveryOutputs() would return, including ones that will never be retried. */
  recoveryCount: number;
  /** The editor is being asked for its current state, which will be the newest recovery output. */
  recovering: boolean;
  /** Observed time of the last confirmed source replacement, never a copy or export. */
  lastSavedAt: number | null;
  autosave: EditorAutosave;
  message: string | null;
  /** Set once the status is `failed` or `access-ended`. */
  reason: EditorStopReason | null;
}

export interface EditorSession {
  getSnapshot(): EditorSnapshot;
  subscribe(listener: () => void): () => void;
  retry(): boolean;
  /** Give up on a failed copy or export. Its bytes stay in getRecoveryOutputs(). */
  dismiss(): boolean;
  /** Flush a native snapshot; an explicit copy never retargets the opened source. */
  requestSave(copy?: { saveAs: true; name: string }): boolean;
  /** Applies only through a negotiated native theme capability, never iframe CSS injection. */
  setTheme(theme: NativeTheme): boolean;
  // Oldest first; the last is the newest. Returned copies remain available even after disposal. Unserialized in-editor edits still
  // require the live editor; callers must check hasUnsavedChanges before removing its frame.
  getRecoveryOutputs(): readonly EditorOutput[];
  dispose(): void;
}
