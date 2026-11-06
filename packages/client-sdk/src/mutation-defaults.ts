import { operations } from "@hyori-cloud/api/rpc";
import type { MutationObserverOptions, QueryClient } from "@hyori-cloud/lib/query-core";
import { reconcileCredentialTransition } from "#client-sdk/features/auth/credential-transition";
import type { Failure, OperationDeclaration, Payload, Success } from "#client-sdk/inference";
import { operationPrefix } from "#client-sdk/operation-key";

const declarations: readonly OperationDeclaration[] = operations;
const registered = new WeakMap<QueryClient, Set<string>>();

type Lifecycle<D extends OperationDeclaration, TContext> = Omit<
  MutationObserverOptions<Success<D>, Failure<D>, Payload<D>, TContext>,
  "mutationKey" | "mutationFn"
>;

function mutationPolicy<D extends OperationDeclaration>(
  queryClient: QueryClient,
  operation: D,
  catalog: readonly OperationDeclaration[],
) {
  const invalidated = catalog.filter(
    (candidate) =>
      candidate.kind === "query" &&
      operation.invalidates?.some(
        (namespace) =>
          candidate.rpc._tag === namespace || candidate.rpc._tag.startsWith(`${namespace}.`),
      ),
  );

  const tags = new Set(invalidated.map((candidate) => candidate.rpc._tag));

  return async (result: Success<D>) => {
    if (operation.resetCache) {
      // Removing records does not cancel their executing observers or lifecycle callbacks.
      // It also prevents late old-identity results from reappearing in the shared cache.
      queryClient.getMutationCache().clear();
      await queryClient.cancelQueries();
      // Keep mounted identity observers, replacing their data before any fallible refresh.
      queryClient.removeQueries({ predicate: (query) => !tags.has(String(query.queryKey[1])) });
      reconcileCredentialTransition<D>(queryClient, operation.rpc._tag, result);
    }

    await Promise.all(
      invalidated.map((candidate) =>
        queryClient.invalidateQueries({ queryKey: operationPrefix(candidate.rpc._tag) }),
      ),
    );
  };
}

/** Typed extensions cannot replace the declaration-owned consistency lifecycle. */
export function setOperationMutationDefaults<D extends OperationDeclaration, TContext>(
  queryClient: QueryClient,
  operation: D,
  catalog: readonly OperationDeclaration[],
  options: Lifecycle<D, TContext>,
): void {
  const reconcile = mutationPolicy(queryClient, operation, catalog);
  queryClient.setMutationDefaults(operationPrefix(operation.rpc._tag), {
    ...options,
    onSuccess: async (...args: Parameters<NonNullable<typeof options.onSuccess>>) => {
      await reconcile(args[0]);
      await options.onSuccess?.(...args);
    },
  });
  let tags = registered.get(queryClient);

  if (!tags) {
    tags = new Set();
    registered.set(queryClient, tags);
  }

  tags.add(operation.rpc._tag);
}

/** Also used by owned SDK subscription lifecycles that complete outside useMutation. */
export function reconcileMutation(
  queryClient: QueryClient,
  key: readonly unknown[],
): Promise<void> {
  const operation = declarations.find(
    (candidate) => candidate.kind === "mutation" && candidate.rpc._tag === key[1],
  );

  if (!operation) throw new Error("No declaration exists for this mutation policy.");

  return mutationPolicy(queryClient, operation, declarations)(undefined);
}

/** One installer per app/request QueryClient. Reinstallation retains typed custom lifecycles. */
export function setMutationDefaults(queryClient: QueryClient): void {
  for (const operation of declarations) {
    if (operation.kind !== "mutation" || registered.get(queryClient)?.has(operation.rpc._tag))
      continue;
    setOperationMutationDefaults(queryClient, operation, declarations, { retry: false });
  }
}
