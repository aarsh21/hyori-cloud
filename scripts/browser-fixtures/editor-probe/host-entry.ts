import type { EditorBackendPort, EditorDocument } from "@hyori-cloud/client-sdk";
import { createNavigationGuard } from "../../../packages/features/src/cloud/navigation-guard.ts";
import { createEditorAttachment } from "../../../packages/features/src/editors/editor-attachment.ts";

type Saved = { readonly name: string; readonly intent: string; readonly bytes: number[] };

export type EditorProbe = {
  readonly status: () => string;
  readonly unsaved: () => boolean;
  readonly message: () => string | null;
  readonly saves: Saved[];
  readonly guardHeld: () => boolean;
  readonly windowIsStable: () => boolean;
  readonly dispose: () => void;
};

/** One real session on one real frame, with storage held in this page. Never proof of persistence. */
function start(document_: EditorDocument, source: number[]): EditorProbe {
  const frame = document.createElement("iframe");

  frame.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0";
  document.body.append(frame);

  const captured = frame.contentWindow;
  const guard = createNavigationGuard();
  const saves: Saved[] = [];
  let revision = Number(document_.revision);

  const backend: EditorBackendPort = {
    open: async () => document_,
    download: async () => new Uint8Array(source),
    save: async ({ output }) => {
      saves.push({ name: output.name, intent: output.intent, bytes: [...output.bytes] });
      revision += 1;

      return { status: "saved", revision: String(revision) };
    },
  };

  const { session, dispose } = createEditorAttachment({ frame, backend, guard });

  return {
    status: () => session.getSnapshot().status,
    unsaved: () => session.getSnapshot().hasUnsavedChanges,
    message: () => session.getSnapshot().message,
    saves,
    guardHeld: () => guard.isHeld(),
    windowIsStable: () => frame.contentWindow === captured,
    dispose() {
      dispose();
      frame.remove();
    },
  };
}

declare global {
  interface Window {
    startEditorProbe: typeof start;
    probe: EditorProbe;
  }
}

window.startEditorProbe = start;
