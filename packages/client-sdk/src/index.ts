export { createClient } from "#client-sdk/client";

export type { Client, ClientOptions } from "#client-sdk/client";

export { ClientError } from "#client-sdk/error-schema";

export { normalizeClientError, SDKError } from "#client-sdk/errors";

export type { InputOf, OutputOf, ErrorOf } from "#client-sdk/inference";

export type { RPC, Query, Mutation } from "#client-sdk/product-types";

export type { RequestOptions } from "#client-sdk/operation-catalog";

export type { FetchCapability } from "#client-sdk/transport";

export type {
  ApiError,
  AuthStatus,
  FileAccess,
  FileEntry,
  FileList,
  FileVersion,
  Share,
  ShareRole,
  UploadStatus,
  User,
  UserIdentity,
} from "#client-sdk/domain-types";

export type {
  ResumeUpload,
  ReplaceUpload,
  StartUpload,
  UploadFile,
  UploadOptions,
  UploadTask,
} from "#client-sdk/features/uploads/upload";

export {
  UploadCheckpoint,
  decodeUploadCheckpoint,
} from "#client-sdk/features/uploads/upload-checkpoint";

export { UploadSnapshot } from "#client-sdk/features/uploads/upload-state";

export { UploadIntent, UploadFailure } from "#client-sdk/features/uploads/upload-intent";

export { getUploadFailure } from "#client-sdk/features/uploads/upload-failure";

export { createUploadQueue } from "#client-sdk/features/uploads/upload-queue";

export { createEditorSession } from "#client-sdk/features/editors/create-editor-session";

export type { EditorBackendOptions } from "#client-sdk/features/editors/create-editors";

export { EditorDocument, EditorAutosave } from "#client-sdk/features/editors/editor-contract";

export type {
  ArtCraftApp,
  BridgedArtCraftApp,
  EditorBackendPort,
  EditorHostMessage,
  EditorMessageEvent,
  EditorMessagePort,
  EditorOutput,
  EditorSaveResult,
  EditorSession,
  EditorSessionOptions,
  EditorSnapshot,
  EditorStatus,
  EditorStopReason,
  EditorVisibilityPort,
  EditorEnginePort,
} from "#client-sdk/features/editors/editor-contract";

export type {
  CheckpointStore,
  UploadEntry,
  UploadQueue,
  UploadSummary,
} from "#client-sdk/features/uploads/upload-queue";
