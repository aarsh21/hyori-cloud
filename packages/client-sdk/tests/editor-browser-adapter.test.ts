import { expect, test } from "bun:test";

import { createBrowserEditorMessages } from "@hyori-cloud/client-sdk/browser";
import type { EditorMessageEvent, EditorMessagePort } from "@hyori-cloud/client-sdk";

// Compile the actual browser call site without requiring a browser in the vanilla consumer.
const browserCallSite = (host: Window, editorWindow: Window): EditorMessagePort =>
  createBrowserEditorMessages({ host, editorWindow, origin: host.location.origin });

void browserCallSite;

test("browser adapter owns exact-origin posting, message subscription and cleanup", () => {
  const listeners = new Set<(event: MessageEvent) => void>();
  const received: EditorMessageEvent[] = [];

  const sent: {
    message: Parameters<EditorMessagePort["post"]>[0];
    targetOrigin: string;
    transfer?: ArrayBuffer[];
  }[] = [];

  const host: Parameters<typeof createBrowserEditorMessages>[0]["host"] = {
    location: { origin: "https://cloud.example" },
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

  const port = createBrowserEditorMessages({ host, editorWindow, origin: host.location.origin });
  const unsubscribe = port.subscribe((event) => received.push(event));
  const data = { type: "wordcraft:ready", version: "0.14.0" };

  for (const listener of listeners)
    listener(new MessageEvent("message", { origin: host.location.origin, data }));

  expect(received).toEqual([{ source: null, origin: host.location.origin, data }]);
  expect(port.source).toBe(editorWindow);
  const message = { type: "wordcraft:open", name: "Report.docx", bytes: new Uint8Array([1]) };
  port.post(message, host.location.origin);
  expect(sent).toEqual([{ message, targetOrigin: host.location.origin, transfer: undefined }]);
  // Exclusively owned buffers are handed over rather than cloned.
  port.post(message, host.location.origin, [message.bytes.buffer]);
  expect(sent[1]?.transfer).toEqual([message.bytes.buffer]);
  expect(() => port.post(message, "*")).toThrow("target origin changed");
  expect(() =>
    createBrowserEditorMessages({ host, editorWindow, origin: "https://other.example" }),
  ).toThrow("same-origin");
  expect(() =>
    createBrowserEditorMessages({ host, editorWindow, origin: "https://cloud.example/path" }),
  ).toThrow("same-origin");
  unsubscribe();
  expect(listeners.size).toBe(0);
});
