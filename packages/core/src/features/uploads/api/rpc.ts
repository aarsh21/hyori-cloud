import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { ApiError, Done } from "#core/features/auth/api/schema";
import { FileEntry } from "#core/features/files/api/schema";
import {
  BeginUpload,
  UploadInput,
  UploadPart,
  UploadPartInput,
  UploadStatus,
} from "#core/features/uploads/api/schema";

export const uploadsOperations = [
  {
    rpc: Rpc.make("uploads.begin", {
      payload: BeginUpload,
      success: UploadStatus,
      error: ApiError,
    }),
    kind: "mutation",
  },
  {
    rpc: Rpc.make("uploads.status", {
      payload: UploadInput,
      success: UploadStatus,
      error: ApiError,
    }),
    kind: "query",
  },
  {
    rpc: Rpc.make("uploads.part", {
      payload: UploadPartInput,
      success: UploadPart,
      error: ApiError,
    }),
    kind: "query",
  },
  {
    rpc: Rpc.make("uploads.complete", {
      payload: UploadInput,
      success: FileEntry,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["files", "auth", "photos", "admin"],
  },
  {
    rpc: Rpc.make("uploads.abort", { payload: UploadInput, success: Done, error: ApiError }),
    kind: "mutation",
    invalidates: ["auth"],
  },
] as const;
