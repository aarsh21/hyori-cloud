export {
  HydrationBoundary,
  QueryClient,
  QueryClientProvider,
  QueryErrorResetBoundary,
  dehydrate,
  hydrate,
  infiniteQueryOptions,
  keepPreviousData,
  queryOptions,
  useInfiniteQuery,
  useIsFetching,
  useIsMutating,
  useMutation,
  useMutationState,
  useQueries,
  useQuery,
  useQueryClient,
  useQueryErrorResetBoundary,
  useSuspenseInfiniteQuery,
  useSuspenseQueries,
  useSuspenseQuery,
} from "@tanstack/react-query";

export type {
  DefaultError,
  InfiniteData,
  QueryClientConfig,
  QueryKey,
  UseInfiniteQueryResult,
  UseMutationOptions,
  UseMutationResult,
  UseQueryOptions,
  UseQueryResult,
  UseSuspenseQueryResult,
} from "@tanstack/react-query";

import type { DefaultError, UseQueryResult, UseSuspenseQueryResult } from "@tanstack/react-query";

type ResourceFields<T> = T extends unknown
  ? Pick<T, Extract<keyof T, "data" | "error" | "status" | "fetchStatus">>
  : never;

export type QueryResource<TData, TError = DefaultError> = ResourceFields<
  UseQueryResult<TData, TError>
>;

export type SuspenseQueryResource<TData, TError = DefaultError> = ResourceFields<
  UseSuspenseQueryResult<TData, TError>
>;

export function createQueryClient(config?: import("@tanstack/react-query").QueryClientConfig) {
  return new OwnedQueryClient(config);
}

import { QueryClient as OwnedQueryClient } from "@tanstack/react-query";
