import { infiniteQueryOptions, useInfiniteQuery } from "@hyori-cloud/lib/query";
import type { InfiniteData, QueryKey } from "@hyori-cloud/lib/query";
import type { CloudError } from "#features/shared/cloud-error.ts";

type CursorPage = { readonly nextCursor: string | null };

/**
 * Keys extend the SDK's operation key, so the centrally declared mutation invalidation reaches
 * these pages without any local key registry. Queries sharing a `retainScope` keep showing the
 * previous pages while the next input loads; other inputs never inherit each other's data.
 * `refreshDelay` looks again while the pages say something is still changing. A failed refresh stops
 * it, leaving the retry to the person looking at the failure.
 */
export function useCursorPages<Input, Page extends CursorPage>(
  operation: { readonly getKey: (input: Input) => QueryKey },
  read: (
    input: Input & { readonly cursor: string | null },
    options: { readonly signal: AbortSignal },
  ) => Promise<Page>,
  input: Input,
  retainScope?: string,
  refreshDelay?: (pages: readonly Page[]) => number | false,
) {
  return useInfiniteQuery({
    ...cursorPagesOptions(operation, read, input),
    refetchInterval: ({ state: { data, error } }) =>
      refreshDelay === undefined || data === undefined || error !== null
        ? false
        : refreshDelay(data.pages),
    meta: { retainScope },
    placeholderData: (previous, previousQuery) =>
      retainScope !== undefined && previousQuery?.meta?.retainScope === retainScope
        ? previous
        : undefined,
  });
}

/** Shared by the screen and its first-document read, including cursor shape and cache identity. */
export function cursorPagesOptions<Input, Page extends CursorPage>(
  operation: { readonly getKey: (input: Input) => QueryKey },
  read: (
    input: Input & { readonly cursor: string | null },
    options: { readonly signal: AbortSignal },
  ) => Promise<Page>,
  input: Input,
) {
  return infiniteQueryOptions<
    Page,
    CloudError,
    InfiniteData<Page, string | null>,
    QueryKey,
    string | null
  >({
    queryKey: [...operation.getKey(input), "pages"],
    queryFn: ({ pageParam, signal }) => read({ ...input, cursor: pageParam }, { signal }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.nextCursor,
    retry: false,
  });
}
