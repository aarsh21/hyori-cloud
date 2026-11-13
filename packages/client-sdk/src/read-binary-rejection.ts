import { ApiError } from "@hyori-cloud/api/wire";
import * as z from "@hyori-cloud/lib/json";
import { normalizeError, SDKError, type ClientError } from "#client-sdk/errors";

const failure = z.object({ ok: z.literal(false), error: ApiError });

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

  const decoded = failure.safeParse(body);

  if (decoded.success) return decoded.data.error;

  if (response.status === 408 || response.status === 429 || response.status >= 500)
    return new SDKError("SDK_TRANSPORT", `Binary request failed (${response.status}).`);

  return new SDKError(
    "SDK_PROTOCOL",
    `The server returned an invalid binary rejection (${response.status}).`,
  );
}
