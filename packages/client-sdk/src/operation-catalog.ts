import type {
  DataTag,
  MutationObserverOptions,
  MutationOptions,
  QueryClient,
  QueryObserverOptions,
} from "@hyori-cloud/lib/query-core";
import type {
  CarrierFor,
  Failure,
  OperationDeclaration,
  OperationTree,
  Payload,
  Success,
} from "#client-sdk/inference";
import { encodeOperationInput } from "#client-sdk/transport";
import { operationPrefix } from "#client-sdk/operation-key";
import { setOperationMutationDefaults } from "#client-sdk/mutation-defaults";

export type RequestOptions = {
  readonly signal?: AbortSignal;
  /** Small, bounded cleanup already admitted before disposal may finish during page exit. */
  readonly keepalive?: boolean;
};

type PayloadArguments<I> = undefined extends I ? [input?: I] : [input: I];

export type RpcOperation<D extends OperationDeclaration> = ((
  ...args: [...PayloadArguments<Payload<D>>, options?: RequestOptions]
) => Promise<Success<D>>) &
  CarrierFor<D>;

export type OperationKey<D extends OperationDeclaration> = DataTag<
  readonly unknown[],
  Success<D>,
  Failure<D>
>;

export type QueryFactoryOptions<D extends OperationDeclaration> = Omit<
  QueryObserverOptions<Success<D>, Failure<D>, Success<D>, Success<D>, OperationKey<D>>,
  "queryFn" | "enabled" | "placeholderData" | "initialData"
> & {
  queryKey: OperationKey<D>;
  queryFn: (context: { signal: AbortSignal }) => Promise<Success<D>>;
  retry: false;
};

export type QueryOperation<D extends OperationDeclaration> = CarrierFor<D> & {
  readonly key: readonly unknown[];
  readonly getKey: ((...args: PayloadArguments<Payload<D>>) => OperationKey<D>) & CarrierFor<D>;
  readonly getOptions: ((...args: PayloadArguments<Payload<D>>) => QueryFactoryOptions<D>) &
    CarrierFor<D>;
};

export type MutationOperation<D extends OperationDeclaration> = CarrierFor<D> & {
  readonly key: readonly unknown[];
  readonly mutationOptions: (() => MutationOptions<Success<D>, Failure<D>, Payload<D>>) &
    CarrierFor<D>;
  readonly setDefaults: <TContext = unknown>(
    client: QueryClient,
    options: Omit<
      MutationObserverOptions<Success<D>, Failure<D>, Payload<D>, TContext>,
      "mutationKey" | "mutationFn"
    >,
  ) => void;
};

export type Invoke = <D extends OperationDeclaration>(
  operation: D,
  input: Payload<D>,
  options?: RequestOptions,
) => Promise<Success<D>>;

function bindQuery<D extends OperationDeclaration>(
  declaration: D,
  invoke: Invoke,
  cacheScope: string,
) {
  const key = operationPrefix(declaration.rpc._tag);

  const getKey = (input: Payload<D>) =>
    [...key, cacheScope, { input: encodeOperationInput(declaration, input) }] as const;

  return {
    key,
    getKey,
    getOptions: (input: Payload<D>) => ({
      queryKey: getKey(input),
      queryFn: ({ signal }: { signal: AbortSignal }) => invoke(declaration, input, { signal }),
      retry: false as const,
    }),
  };
}

function bindMutation<D extends OperationDeclaration>(
  declaration: D,
  invoke: Invoke,
  declarations: readonly OperationDeclaration[],
) {
  const key = operationPrefix(declaration.rpc._tag);

  return {
    key,
    mutationOptions: () => ({
      mutationKey: key,
      mutationFn: (input: Payload<D>) => invoke(declaration, input),
      retry: false,
    }),
    setDefaults: <TContext>(
      client: QueryClient,
      options: Omit<
        MutationObserverOptions<Success<D>, Failure<D>, Payload<D>, TContext>,
        "mutationKey" | "mutationFn"
      >,
    ) => setOperationMutationDefaults(client, declaration, declarations, options),
  };
}

type CatalogLeaf<D extends OperationDeclaration> =
  | ((input: Payload<D>, options?: RequestOptions) => Promise<Success<D>>)
  | ReturnType<typeof bindQuery<D>>
  | ReturnType<typeof bindMutation<D>>;

class CatalogNamespace<D extends OperationDeclaration> {
  [segment: string]: CatalogNamespace<D> | CatalogLeaf<D> | undefined;
}

function assignPath<D extends OperationDeclaration>(
  tree: CatalogNamespace<D>,
  path: string,
  value: CatalogLeaf<D>,
) {
  const segments = path.split(".");

  if (
    segments.some(
      (segment) =>
        !segment || segment === "__proto__" || segment === "constructor" || segment === "prototype",
    )
  )
    throw new Error("Unsafe operation path");
  let cursor = tree;

  for (const segment of segments.slice(0, -1)) {
    const existing = cursor[segment];

    if (!Object.hasOwn(cursor, segment)) {
      const namespace = new CatalogNamespace<D>();
      cursor[segment] = namespace;
      cursor = namespace;
    } else if (existing instanceof CatalogNamespace) {
      cursor = existing;
    } else {
      throw new Error(`Operation namespace collides with a leaf: ${path}`);
    }
  }

  const leaf = segments.at(-1);

  if (!leaf) throw new Error("Empty operation path");

  if (Object.hasOwn(cursor, leaf)) throw new Error(`Duplicate operation ${path}`);
  cursor[leaf] = value;
}

export type DerivedOperations<D extends readonly OperationDeclaration[]> = {
  rpc: OperationTree<D[number], "rpc">;
  query: OperationTree<D[number], "query">;
  mutation: OperationTree<D[number], "mutation">;
};

/** The only catalog binding. Runtime methods and static trees share the same declarations. */
export function deriveOperations<const D extends readonly OperationDeclaration[]>(
  declarations: D,
  invoke: Invoke,
  cacheScope: string,
) {
  const rpc = new CatalogNamespace<D[number]>();
  const query = new CatalogNamespace<D[number]>();
  const mutation = new CatalogNamespace<D[number]>();

  for (const declaration of declarations) {
    assignPath(rpc, declaration.rpc._tag, (input: Payload<D[number]>, options?: RequestOptions) =>
      invoke(declaration, input, options),
    );

    if (declaration.kind === "query") {
      assignPath(query, declaration.rpc._tag, bindQuery(declaration, invoke, cacheScope));
    } else {
      assignPath(mutation, declaration.rpc._tag, bindMutation(declaration, invoke, declarations));
    }
  }

  // SAFETY: every leaf is built from its declaration's codecs and kind; assignPath rejects duplicate,
  // unsafe and leaf/namespace-colliding tags. Only the string-path/mapped-type correlation and phantom
  // Query data tags are asserted here; the public compile/evolution fixtures verify their inference.
  return { rpc, query, mutation } as DerivedOperations<D>;
}
