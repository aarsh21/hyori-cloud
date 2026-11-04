import type {
  CreateShare,
  ResolveShare,
  ShareInput,
  SharesListInput,
  UnlockShare,
} from "#core/features/shares/api/schema";
import { SharesService } from "#core/features/shares/service";
import type { RequestContext } from "#core/runtime";

export function sharesHandlers(context: RequestContext) {
  const service = new SharesService(context);

  return {
    "shares.list": (input: typeof SharesListInput.Type) => service.list(input),
    "shares.create": (input: typeof CreateShare.Type) => service.create(input),
    "shares.revoke": (input: typeof ShareInput.Type) => service.revoke(input),
    "shares.resolve": (input: typeof ResolveShare.Type) => service.resolve(input),
    "shares.unlock": (input: typeof UnlockShare.Type) => service.unlock(input),
  };
}
