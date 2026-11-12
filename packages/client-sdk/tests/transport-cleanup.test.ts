import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const sessionId = "a".repeat(64);

test("an admitted keepalive cleanup survives SDK disposal, but new calls remain forbidden", async () => {
  const reply = Promise.withResolvers<Response>();
  let captured: RequestInit | undefined;

  const client = createClient({
    fetch: async (_url, init) => {
      captured = init;

      return reply.promise;
    },
  });

  const close = client.rpc.editors.close({ sessionId }, { keepalive: true });
  await tick();
  client.dispose();
  expect(captured?.keepalive).toBe(true);
  expect(captured?.signal?.aborted).toBe(false);
  reply.resolve(Response.json({ ok: true, value: { success: true } }));
  expect(await close).toEqual({ success: true });
  await expect(client.rpc.editors.close({ sessionId }, { keepalive: true })).rejects.toMatchObject({
    code: "SDK_DISPOSED",
  });
});

test("explicit cancellation still aborts an admitted keepalive request", async () => {
  const reply = Promise.withResolvers<Response>();
  const abort = new AbortController();
  let signal: AbortSignal | null | undefined;

  const client = createClient({
    fetch: async (_url, init) => {
      signal = init?.signal;

      return reply.promise;
    },
  });

  const close = client.rpc.editors.close({ sessionId }, { keepalive: true, signal: abort.signal });
  await tick();
  abort.abort();
  expect(signal?.aborted).toBe(true);
  reply.resolve(Response.json({ ok: true, value: { success: true } }));
  await expect(close).rejects.toMatchObject({ code: "SDK_CANCELLED" });
  client.dispose();
});

test("ordinary requests remain cancelled by SDK disposal", async () => {
  const reply = Promise.withResolvers<Response>();
  let signal: AbortSignal | null | undefined;

  const client = createClient({
    fetch: async (_url, init) => {
      signal = init?.signal;

      return reply.promise;
    },
  });

  const status = client.rpc.auth.status({});
  await tick();
  client.dispose();
  expect(signal?.aborted).toBe(true);
  reply.resolve(Response.json({ ok: true, value: { initialized: true, user: null } }));
  await expect(status).rejects.toMatchObject({ code: "SDK_CANCELLED" });
});
