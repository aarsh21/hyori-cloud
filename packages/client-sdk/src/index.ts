export { createClient } from "#client-sdk/client";

export type { Client, ClientOptions } from "#client-sdk/client";

export { ClientError, normalizeClientError, SDKError } from "#client-sdk/errors";

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
} from "#client-sdk/domain-types";

export type {
  ResumeUpload,
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

export { createUploadQueue } from "#client-sdk/features/uploads/upload-queue";

export type {
  CheckpointStore,
  UploadEntry,
  UploadQueue,
  UploadSummary,
} from "#client-sdk/features/uploads/upload-queue";
