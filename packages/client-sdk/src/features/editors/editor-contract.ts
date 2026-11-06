import { EditorApp, EditorDocument as ProductEditorDocument, Name } from "@hyori-cloud/api/rpc";
import type { EditorIntent, EditorPrepareSave, EditorSaved } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";

import type { NativeHostCommand, NativeTheme } from "#client-sdk/features/editors/native-runtime";

// Rust owns public descriptors. The remaining contracts describe local byte/frame capabilities.
export type ArtCraftApp = typeof EditorApp.Type;

export const BridgedArtCraftApp = EditorApp;

export type BridgedArtCraftApp = typeof BridgedArtCraftApp.Type;

export const EditorName = Name.pipe(
  Schema.filter(
    (value) =>
      value === value.trim() &&
      value !== "." &&
      value !== ".." &&
      !/[\\/\p{Cc}\p{Cf}]/u.test(value),
  ),
);

export const EditorDocument = ProductEditorDocument;

export type EditorDocument = typeof EditorDocument.Type;

export interface EditorOutput {
  name: string;
  bytes: Uint8Array<ArrayBuffer>;
  intent: EditorIntent;
}

export type EditorSaveResult =
  | Pick<EditorSaved, "status" | "revision">
  | { status: "conflict"; message: string }
  | { status: "read-only"; message: string }
  | { status: "access-ended"; message: string }
  | { status: "failed"; message: string };

export interface EditorBackendPort {
  open(options: { signal: AbortSignal }): Promise<EditorDocument>;
  /** Retire this bound resource; unresolved saves must retain their server reconciliation state. */
  close?(): Promise<void>;
  download(document: EditorDocument, options: { signal: AbortSignal }): Promise<Uint8Array>;
  // A non-replacement output must never replace the source. The binding must obtain any
  // required destination/user choice, or return failed; it cannot silently reinterpret intent.
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
  post(message: EditorHostMessage, targetOrigin: string): void;
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
}

export interface EditorSnapshot {
  status: EditorStatus;
  document: EditorDocument | null;
  hasUnsavedChanges: boolean;
  pendingSaveCount: number;
  /** Observed time of the last confirmed source replacement, never a copy or export. */
  lastSavedAt: number | null;
  autosave: EditorAutosave;
  message: string | null;
}

export interface EditorSession {
  getSnapshot(): EditorSnapshot;
  subscribe(listener: () => void): () => void;
  retry(): boolean;
  /** Flush a native snapshot; an explicit copy never retargets the opened source. */
  requestSave(copy?: { saveAs: true; name: string }): boolean;
  /** Applies only through a negotiated native theme capability, never iframe CSS injection. */
  setTheme(theme: NativeTheme): boolean;
  // Returned copies remain available even after disposal. Unserialized in-editor edits still
  // require the live editor; callers must check hasUnsavedChanges before removing its frame.
  getRecoveryOutputs(): readonly EditorOutput[];
  dispose(): void;
}
