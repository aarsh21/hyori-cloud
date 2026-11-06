import { ApiError } from "@hyori-cloud/api/rpc";
import { Either, Schema } from "@hyori-cloud/lib/effect";
import { normalizeError, SDKError, type ClientError } from "#client-sdk/errors";

const decodeFailure = Schema.decodeUnknownEither(
  Schema.Struct({ ok: Schema.Literal(false), error: ApiError }),
);

/** Binary routes use the same declared failures as RPC, not a success-schema mismatch. */
export async function readBinaryRejection(
  response: Response,
  signal?: AbortSignal,
): Promise<ClientError> {
  let body: unknown;

  try {
    body = await response.json();
  } catch (cause) {
    if (signal?.aborted)
      return new SDKError("SDK_CANCELLED", "The operation was cancelled.", { cause });

    if (!(cause instanceof SyntaxError)) return normalizeError(cause);
  }

  const decoded = decodeFailure(body);

  if (Either.isRight(decoded)) return decoded.right.error;

  if (response.status === 408 || response.status === 429 || response.status >= 500)
    return new SDKError("SDK_TRANSPORT", `Binary request failed (${response.status}).`);

  return new SDKError(
    "SDK_PROTOCOL",
    `The server returned an invalid binary rejection (${response.status}).`,
  );
}
