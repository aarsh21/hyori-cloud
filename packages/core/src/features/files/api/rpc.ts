import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { ApiError } from "#core/features/auth/api/schema";
import {
  CreateFolder,
  Download,
  DownloadInput,
  FileEntry,
  FileList,
  ItemInput,
  ListFiles,
  ListVersions,
  MoveFile,
  RenameFile,
  RestoreVersion,
  Versions,
} from "#core/features/files/api/schema";

export const filesOperations = [
  {
    rpc: Rpc.make("files.list", { payload: ListFiles, success: FileList, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("files.createFolder", {
      payload: CreateFolder,
      success: FileEntry,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["files", "photos"],
  },
  {
    rpc: Rpc.make("files.rename", { payload: RenameFile, success: FileEntry, error: ApiError }),
    kind: "mutation",
    invalidates: ["files", "photos"],
  },
  {
    rpc: Rpc.make("files.move", { payload: MoveFile, success: FileEntry, error: ApiError }),
    kind: "mutation",
    invalidates: ["files", "photos", "shares"],
  },
  {
    rpc: Rpc.make("files.trash", { payload: ItemInput, success: FileEntry, error: ApiError }),
    kind: "mutation",
    invalidates: ["files", "photos", "shares"],
  },
  {
    rpc: Rpc.make("files.restore", { payload: ItemInput, success: FileEntry, error: ApiError }),
    kind: "mutation",
    invalidates: ["files", "photos"],
  },
  {
    rpc: Rpc.make("files.versions", { payload: ListVersions, success: Versions, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("files.restoreVersion", {
      payload: RestoreVersion,
      success: FileEntry,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["files", "photos", "auth"],
  },
  {
    rpc: Rpc.make("files.download", { payload: DownloadInput, success: Download, error: ApiError }),
    kind: "query",
  },
] as const;
