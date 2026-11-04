import type { AcceptInvite, Credentials, Setup } from "#core/features/auth/api/schema";
import { AuthService } from "#core/features/auth/service";
import type { RequestContext } from "#core/runtime";

export function authHandlers(context: RequestContext) {
  const service = new AuthService(context);

  return {
    "auth.status": () => service.status(),
    "auth.setup": (input: typeof Setup.Type) => service.setup(input),
    "auth.login": (input: typeof Credentials.Type) => service.login(input),
    "auth.logout": () => service.logout(),
    "auth.acceptInvite": (input: typeof AcceptInvite.Type) => service.acceptInvite(input),
  };
}
