import type { EditorMessagePort } from "#client-sdk/features/editors/editor-contract";

// The app composition owner must register/mount this host adapter and dispose the session
// before removing or navigating its frame. Same-origin vendor WASM is trusted executable code;
// allow-scripts + allow-same-origin is not an isolation boundary for uploaded HTML/SVG.
export function createBrowserEditorMessages(options: {
  host: {
    location: { readonly origin: string };
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
    removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  };
  editorWindow: {
    postMessage(message: Parameters<EditorMessagePort["post"]>[0], targetOrigin: string): void;
  };
  origin: string;
}): EditorMessagePort {
  const { host, editorWindow, origin } = options;

  if (new URL(origin).origin !== origin || host.location.origin !== origin) {
    throw new Error("ArtCraft requires an exact same-origin attachment");
  }

  return {
    origin,
    source: editorWindow,
    subscribe(listener) {
      const receive = (event: MessageEvent) =>
        listener({ origin: event.origin, source: event.source, data: event.data });

      host.addEventListener("message", receive);

      return () => host.removeEventListener("message", receive);
    },
    post(message, targetOrigin) {
      if (targetOrigin !== origin) throw new Error("Editor target origin changed");
      editorWindow.postMessage(message, origin);
    },
  };
}
