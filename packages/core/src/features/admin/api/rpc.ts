import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { ApiError, User } from "#core/features/auth/api/schema";
import {
  CreateInvite,
  CreateUser,
  DeleteUser,
  Invite,
  PurgeResult,
  SetQuota,
  UsersInput,
  UsersList,
} from "#core/features/admin/api/schema";

export const adminOperations = [
  {
    rpc: Rpc.make("admin.users", { payload: UsersInput, success: UsersList, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("admin.createUser", { payload: CreateUser, success: User, error: ApiError }),
    kind: "mutation",
    invalidates: ["admin"],
  },
  {
    rpc: Rpc.make("admin.createInvite", {
      payload: CreateInvite,
      success: Invite,
      error: ApiError,
    }),
    kind: "mutation",
  },
  {
    rpc: Rpc.make("admin.setQuota", { payload: SetQuota, success: User, error: ApiError }),
    kind: "mutation",
    invalidates: ["admin", "auth"],
  },
  {
    rpc: Rpc.make("admin.deleteUser", {
      payload: DeleteUser,
      success: PurgeResult,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["admin", "shares", "files", "photos"],
  },
] as const;
