import type { IncomingMessage } from "node:http";
import { pipeline } from "node:stream/promises";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

function contentDecoder(encoding: string | undefined) {
  switch (encoding) {
    case "gzip":
      return createGunzip();
    case "deflate":
      return createInflate();
    case "br":
      return createBrotliDecompress();
    default:
      return null;
  }
}

/** Match Fetch's decoded-body semantics; the generic proxy strips decoded encoding/length headers. */
export function nodeResponseStream(incoming: IncomingMessage, headers: Headers) {
  const decoder = contentDecoder(headers.get("content-encoding")?.toLowerCase());
  const source = decoder ?? incoming;

  if (decoder) void pipeline(incoming, decoder).catch(() => {});
  const iterator = source[Symbol.asyncIterator]();

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();

        if (next.done) controller.close();
        else {
          if (!(next.value instanceof Uint8Array)) throw new Error("Non-byte backend stream");
          controller.enqueue(next.value);
        }
      } catch (error) {
        incoming.destroy();
        controller.error(error);
      }
    },
    cancel() {
      source.destroy();
      incoming.destroy();
    },
  });
}
