import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { ApiError, Done } from "#core/features/auth/api/schema";
import {
  CreateShare,
  ResolvedShare,
  ResolveShare,
  Share,
  ShareInput,
  SharesList,
  SharesListInput,
  UnlockShare,
} from "#core/features/shares/api/schema";

export const sharesOperations = [
  {
    rpc: Rpc.make("shares.list", {
      payload: SharesListInput,
      success: SharesList,
      error: ApiError,
    }),
    kind: "query",
  },
  {
    rpc: Rpc.make("shares.create", { payload: CreateShare, success: Share, error: ApiError }),
    kind: "mutation",
    invalidates: ["shares", "files"],
  },
  {
    rpc: Rpc.make("shares.revoke", { payload: ShareInput, success: Done, error: ApiError }),
    kind: "mutation",
    invalidates: ["shares", "files", "photos"],
  },
  {
    rpc: Rpc.make("shares.resolve", {
      payload: ResolveShare,
      success: ResolvedShare,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["files", "shares"],
  },
  {
    rpc: Rpc.make("shares.unlock", {
      payload: UnlockShare,
      success: ResolvedShare,
      error: ApiError,
    }),
    kind: "mutation",
    invalidates: ["files", "shares"],
  },
] as const;
