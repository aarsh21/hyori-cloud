import { expect, test } from "bun:test";
import { hashEditorBytes, readEditorBytes } from "#client-sdk/features/editors/editor-bytes";

const active = () => new AbortController().signal;

test("editor hash covers exactly the selected byte range in canonical lower-case hex", async () => {
  const bytes = new TextEncoder().encode("!abc!");
  expect(await hashEditorBytes(bytes.subarray(1, 4), active())).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
});

test("cancelled hashing never advances into upload preparation", async () => {
  const controller = new AbortController();
  const hash = hashEditorBytes(new Uint8Array([1]), controller.signal);
  controller.abort();
  await expect(hash).rejects.toMatchObject({ code: "SDK_CANCELLED" });
});

test("editor download fills only its descriptor-sized allocation across chunk boundaries", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      controller.enqueue(new Uint8Array([2, 3]));
      controller.close();
    },
  });

  expect(await readEditorBytes(new Response(body), 3, 16, active())).toEqual(
    new Uint8Array([1, 2, 3]),
  );
});

test("oversized editor descriptors cancel before allocating or reading the body", async () => {
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });

  await expect(
    readEditorBytes(new Response(body), 65 * 1024 * 1024, 64 * 1024 * 1024, active()),
  ).rejects.toMatchObject({ code: "SDK_PROTOCOL" });
  expect(cancelled).toBe(true);
});

test("an oversized byte stream is cancelled instead of being collected past the declared bound", async () => {
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2, 3, 4]));
    },
    cancel() {
      cancelled = true;
    },
  });

  await expect(readEditorBytes(new Response(body), 3, 16, active())).rejects.toMatchObject({
    code: "SDK_PROTOCOL",
  });
  expect(cancelled).toBe(true);
});

test("a truncated editor stream cannot become a successfully opened document", async () => {
  await expect(
    readEditorBytes(new Response(new Uint8Array([1, 2])), 3, 16, active()),
  ).rejects.toMatchObject({ code: "SDK_PROTOCOL" });
});

test("abort cancels a pending reader even when the injected response does not bind the signal", async () => {
  const controller = new AbortController();
  let cancelled = false;

  const body = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });

  const read = readEditorBytes(new Response(body), 3, 16, controller.signal);
  controller.abort();
  await expect(read).rejects.toMatchObject({ code: "SDK_CANCELLED" });
  expect(cancelled).toBe(true);
});

test("failed responses and failed streams have explicit failures rather than fabricated EOF", async () => {
  let cancelled = false;

  const rejected = new ReadableStream<Uint8Array>({
    cancel() {
      cancelled = true;
    },
  });

  await expect(
    readEditorBytes(new Response(rejected, { status: 409 }), 3, 16, active()),
  ).rejects.toMatchObject({ code: "SDK_PROTOCOL" });
  expect(cancelled).toBe(true);

  const broken = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error("Synthetic truncated socket"));
    },
  });

  await expect(readEditorBytes(new Response(broken), 3, 16, active())).rejects.toMatchObject({
    code: "SDK_TRANSPORT",
  });
});
