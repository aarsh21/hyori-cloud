import { SDKError } from "#client-sdk/errors";

export async function hashEditorBytes(bytes: Uint8Array<ArrayBuffer>, signal: AbortSignal) {
  if (signal.aborted) throw new SDKError("SDK_CANCELLED", "The editor save was cancelled.");
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  if (signal.aborted) throw new SDKError("SDK_CANCELLED", "The editor save was cancelled.");

  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function readEditorBytes(
  response: Response,
  expectedSize: number,
  maximumSize: number,
  signal: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(expectedSize) ||
    !Number.isSafeInteger(maximumSize) ||
    expectedSize <= 0 ||
    expectedSize > maximumSize ||
    maximumSize > 64 * 1024 * 1024
  ) {
    await response.body?.cancel().catch(() => undefined);
    throw new SDKError("SDK_PROTOCOL", "The editor document exceeds its bounded descriptor.");
  }

  if (signal.aborted) {
    await response.body?.cancel().catch(() => undefined);
    throw new SDKError("SDK_CANCELLED", "The editor download was cancelled.");
  }

  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => undefined);
    throw new SDKError("SDK_PROTOCOL", "The editor download has no successful byte stream.");
  }

  const reader = response.body.getReader();

  const abort = () => {
    void reader.cancel().catch(() => undefined);
  };

  signal.addEventListener("abort", abort, { once: true });
  const bytes = new Uint8Array(expectedSize);
  let offset = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (signal.aborted) throw new SDKError("SDK_CANCELLED", "The editor download was cancelled.");

      if (chunk.done) break;

      if (chunk.value.byteLength > expectedSize - offset)
        throw new SDKError("SDK_PROTOCOL", "The editor download exceeds its declared size.");
      bytes.set(chunk.value, offset);
      offset += chunk.value.byteLength;
    }

    if (offset !== expectedSize)
      throw new SDKError("SDK_PROTOCOL", "The editor download ended before its declared size.");

    return bytes;
  } catch (cause) {
    await reader.cancel().catch(() => undefined);

    if (cause instanceof SDKError) throw cause;

    if (signal.aborted)
      throw new SDKError("SDK_CANCELLED", "The editor download was cancelled.", { cause });
    throw new SDKError("SDK_TRANSPORT", "The editor byte stream failed.", { cause });
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}
