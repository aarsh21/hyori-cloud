import type * as API from "@hyori-cloud/api/rpc";
import type { Schema } from "@hyori-cloud/lib/effect";

export type {
  ApiError,
  DisplayPreview,
  FileEntry,
  ShareRole,
  UploadStatus,
  User,
  UserIdentity,
} from "@hyori-cloud/api/rpc";

export type AuthStatus = Schema.Schema.Type<typeof API.AuthStatus>;

export type FileList = Schema.Schema.Type<typeof API.FileList>;

export type FileVersion = Schema.Schema.Type<typeof API.FileVersion>;

export type FileAccess = Schema.Schema.Type<typeof API.Access>;

export type Share = Schema.Schema.Type<typeof API.Share>;
