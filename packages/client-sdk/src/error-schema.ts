import { ApiError } from "@hyori-cloud/api/client";
import { Schema } from "@hyori-cloud/lib/effect";
import { SDKError } from "#client-sdk/errors";

/** Effect compatibility for schema consumers; not required by the JSON transport. */
export const ClientError = Schema.Union(ApiError, Schema.instanceOf(SDKError));

export type ClientError = import("#client-sdk/errors").ClientError;
