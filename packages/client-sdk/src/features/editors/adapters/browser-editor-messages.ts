import type {
  EditorEnginePort,
  EditorMessagePort,
  EditorVisibilityPort,
} from "#client-sdk/features/editors/editor-contract";

/**
 * The origin every message from a sandboxed editor frame carries. The frame runs without
 * `allow-same-origin`, so editor code holds none of the host's authority, and the captured window
 * is what identifies it.
 */
const OPAQUE_ORIGIN = "null";

// The app composition owner must register/mount this host adapter and dispose the session
// before removing or navigating its frame. The frame must be sandboxed without allow-same-origin.
export function createBrowserEditorMessages(options: {
  host: {
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  };
  editorWindow: {
    postMessage(
      message: Parameters<EditorMessagePort["post"]>[0],
      options: { targetOrigin: string; transfer?: ArrayBuffer[] },
    ): void;
  };
}): EditorMessagePort {
  const { host, editorWindow } = options;

  return {
    origin: OPAQUE_ORIGIN,
    source: editorWindow,
    subscribe(listener) {
      const receive = (event: MessageEvent) =>
        listener({ origin: event.origin, source: event.source, data: event.data });

      host.addEventListener("message", receive);

      return () => host.removeEventListener("message", receive);
    },
    post(message, targetOrigin, transfer) {
      if (targetOrigin !== OPAQUE_ORIGIN) throw new Error("Editor target origin changed");
      // An opaque origin can't be named as a target. Only this exact window receives the message.
      editorWindow.postMessage(message, { targetOrigin: "*", transfer });
    },
  };
}

export function createBrowserEditorVisibility(document: {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}): EditorVisibilityPort {
  return {
    hidden: () => document.hidden,
    subscribe(listener) {
      document.addEventListener("visibilitychange", listener);

      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/**
 * The host's own fetch of the engine its descriptor names: same-origin and immutable, so it comes
 * from the HTTP cache after the first open. Bytes that differ from the descriptor are refused.
 */
export function createBrowserEditorEngine(host: {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  crypto: { subtle: Pick<SubtleCrypto, "digest"> };
}): EditorEnginePort {
  return {
    async load(engine, { signal }) {
      const response = await host.fetch(engine.url, { signal, credentials: "same-origin" });

      if (!response.ok) throw new Error("The editor engine didn't load");
      const bytes = await response.arrayBuffer();
      const digest = new Uint8Array(await host.crypto.subtle.digest("SHA-256", bytes));
      const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");

      if (bytes.byteLength !== engine.bytes || hex !== engine.sha256)
        throw new Error("The editor engine differs from its descriptor");

      return bytes;
    },
  };
}
