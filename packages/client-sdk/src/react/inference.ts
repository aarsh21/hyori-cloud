import type { QueryResource, SuspenseQueryResource } from "@hyori-cloud/lib/query";
import type { ErrorOf, OutputOf, QueryOperationType } from "#client-sdk/inference";

export type ResourceOf<T extends QueryOperationType> = QueryResource<OutputOf<T>, ErrorOf<T>>;

export type SuspenseResourceOf<T extends QueryOperationType> = SuspenseQueryResource<
  OutputOf<T>,
  ErrorOf<T>
>;
