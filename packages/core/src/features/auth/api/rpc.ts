import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import {
  AcceptInvite,
  ApiError,
  AuthStatus,
  Credentials,
  Done,
  Empty,
  Setup,
  User,
} from "#core/features/auth/api/schema";

export const authOperations = [
  {
    rpc: Rpc.make("auth.status", { payload: Empty, success: AuthStatus, error: ApiError }),
    kind: "query",
  },
  {
    rpc: Rpc.make("auth.setup", { payload: Setup, success: User, error: ApiError }),
    kind: "mutation",
    invalidates: ["auth"],
    resetCache: true,
  },
  {
    rpc: Rpc.make("auth.login", { payload: Credentials, success: User, error: ApiError }),
    kind: "mutation",
    invalidates: ["auth"],
    resetCache: true,
  },
  {
    rpc: Rpc.make("auth.logout", { payload: Empty, success: Done, error: ApiError }),
    kind: "mutation",
    invalidates: ["auth"],
    resetCache: true,
  },
  {
    rpc: Rpc.make("auth.acceptInvite", { payload: AcceptInvite, success: User, error: ApiError }),
    kind: "mutation",
    invalidates: ["auth"],
    resetCache: true,
  },
] as const;
