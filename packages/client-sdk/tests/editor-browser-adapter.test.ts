import { expect, test } from "bun:test";

import {
  createBrowserEditorEngine,
  createBrowserEditorMessages,
} from "@hyori-cloud/client-sdk/browser";
import type { EditorMessageEvent, EditorMessagePort } from "@hyori-cloud/client-sdk";

// Compile the actual browser call site without requiring a browser in the vanilla consumer.
const browserCallSite = (host: Window, editorWindow: Window): EditorMessagePort =>
  createBrowserEditorMessages({ host, editorWindow });

void browserCallSite;

test("browser adapter owns sandboxed-frame posting, message subscription and cleanup", () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const received: EditorMessageEvent[] = [];

  const sent: {
    message: Parameters<EditorMessagePort["post"]>[0];
    targetOrigin: string;
    transfer?: ArrayBuffer[];
  }[] = [];

  const host: Parameters<typeof createBrowserEditorMessages>[0]["host"] = {
    addEventListener(type, listener) {
      expect(type).toBe("message");
      listeners.add(listener);
    },
    removeEventListener(type, listener) {
      expect(type).toBe("message");
      listeners.delete(listener);
    },
  };

  const editorWindow: Parameters<typeof createBrowserEditorMessages>[0]["editorWindow"] = {
    postMessage(message, { targetOrigin, transfer }) {
      sent.push({ message, targetOrigin, transfer });
    },
  };

  const port = createBrowserEditorMessages({ host, editorWindow });
  const unsubscribe = port.subscribe((event) => received.push(event));
  const data = { type: "wordcraft:ready", version: "0.14.0" };

  for (const listener of listeners) listener(new MessageEvent("message", { origin: "null", data }));

  expect(received).toEqual([{ source: null, origin: "null", data }]);
  // A sandboxed frame has the opaque origin; its captured window is what identifies it.
  expect(port.origin).toBe("null");
  expect(port.source).toBe(editorWindow);
  const message = { type: "wordcraft:open", name: "Report.docx", bytes: new Uint8Array([1]) };
  port.post(message, "null");
  // An opaque origin can't be named as a target, so only the exact window gets the message.
  expect(sent).toEqual([{ message, targetOrigin: "*", transfer: undefined }]);
  // Exclusively owned buffers are handed over rather than cloned.
  port.post(message, "null", [message.bytes.buffer]);
  expect(sent[1]?.transfer).toEqual([message.bytes.buffer]);
  expect(() => port.post(message, "https://cloud.example")).toThrow("target origin changed");
  unsubscribe();
  expect(listeners.size).toBe(0);
});

test("the host hands over only an engine whose size and SHA-256 match its descriptor", async () => {
  const bytes = new TextEncoder().encode("engine");
  const sha256 = new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
  const fetched: string[] = [];

  const engine = createBrowserEditorEngine({
    fetch: async (url) => {
      fetched.push(url);

      return new Response(bytes);
    },
    crypto,
  });

  const url = "/artcraft/wordcraft/1/editor_bg.wasm";
  const signal = new AbortController().signal;
  const loaded = await engine.load({ url, sha256, bytes: bytes.byteLength }, { signal });

  expect(new Uint8Array(loaded)).toEqual(bytes);
  expect(fetched).toEqual([url]);
  await expect(engine.load({ url, sha256: "0".repeat(64), bytes: 6 }, { signal })).rejects.toThrow(
    "differs",
  );
  await expect(engine.load({ url, sha256, bytes: 7 }, { signal })).rejects.toThrow("differs");
});
