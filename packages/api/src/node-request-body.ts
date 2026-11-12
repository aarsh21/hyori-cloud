import { Readable } from "node:stream";

/** Cancel the reader directly: an async iterator's return can wait forever on a pending read. */
export function nodeRequestBody(body: ReadableStream<Uint8Array>): Readable {
  const reader = body.getReader();

  return new Readable({
    read() {
      void reader.read().then(
        (next) => this.push(next.done ? null : next.value),
        (error) =>
          this.destroy(error instanceof Error ? error : new Error("Request stream failed")),
      );
    },
    destroy(error, callback) {
      void reader.cancel(error).then(
        () => callback(error),
        () => callback(error),
      );
    },
  });
}
