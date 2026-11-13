import { ApiError } from "@hyori-cloud/api/wire";

export class SDKError extends Error {
  readonly name = "SDKError";
  constructor(
    readonly code:
      | "SDK_TRANSPORT"
      | "SDK_PROTOCOL"
      | "SDK_VALIDATION"
      | "SDK_CANCELLED"
      | "SDK_DISPOSED"
      | "SDK_FILE_MISMATCH",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export type ClientError = ApiError | SDKError;

/** Query/host observer boundaries can expose failures without preserving their generic type. */
export function normalizeClientError(cause: unknown): ClientError {
  if (cause instanceof SDKError) return cause;
  const parsed = ApiError.safeParse(cause);

  return parsed.success ? parsed.data : normalizeError(cause);
}

export function normalizeError(cause: unknown): SDKError {
  if (cause instanceof SDKError) return cause;

  if (cause instanceof DOMException && cause.name === "AbortError") {
    return new SDKError("SDK_CANCELLED", "The operation was cancelled.", { cause });
  }

  return new SDKError(
    "SDK_TRANSPORT",
    cause instanceof Error ? cause.message : "The request failed.",
    { cause },
  );
}
