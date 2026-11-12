import { PasswordResetResult, User } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";
import type { QueryClient } from "@hyori-cloud/lib/query-core";
import { operationPrefix } from "#client-sdk/operation-key";
import type { OperationDeclaration, Success } from "#client-sdk/inference";
import type { AuthStatus } from "#client-sdk/domain-types";

/** Credential mutations already establish identity; a failed refresh must not restore its predecessor. */
export function reconcileCredentialTransition<D extends OperationDeclaration>(
  queryClient: QueryClient,
  operation: D["rpc"]["_tag"],
  result: Success<D>,
): void {
  switch (operation) {
    case "auth.resetPassword": {
      const reset = Schema.decodeUnknownSync(PasswordResetResult)(result);
      queryClient.setQueriesData<AuthStatus>(
        { queryKey: operationPrefix("auth.status") },
        (previous) =>
          previous?.user?.id === reset.userId ? { ...previous, user: null } : previous,
      );
      break;
    }

    case "auth.logout":
      queryClient.setQueriesData<AuthStatus>(
        { queryKey: operationPrefix("auth.status") },
        (previous) => previous && { initialized: previous.initialized, user: null },
      );
      break;
    case "auth.login":
    case "auth.setup":
    case "auth.acceptInvite":
      queryClient.setQueriesData(
        { queryKey: operationPrefix("auth.status") },
        { initialized: true, user: Schema.decodeUnknownSync(User)(result) },
      );
      break;
  }
}
