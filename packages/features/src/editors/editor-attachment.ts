import { createEditorSession } from "@hyori-cloud/client-sdk";
import type { EditorBackendPort, EditorSession } from "@hyori-cloud/client-sdk";
import { createBrowserEditorMessages } from "@hyori-cloud/client-sdk/browser";
import type { NavigationGuard } from "#features/cloud/navigation-guard.ts";

// The largest any editor's descriptor may ask for. The server's own limit applies within this.
const MAX_EDITOR_BYTES = 64 * 1024 * 1024;

type Attachment = {
  readonly session: EditorSession;
  /** Ends the session while the frame still exists, then lets the host stop warning. */
  readonly dispose: () => void;
};

/** Only a path on this origin. Editors run as same-origin code, so nothing else may ever load. */
function isSameOriginPath(url: string) {
  return url.startsWith("/") && !url.startsWith("//") && !url.includes("\\");
}

/**
 * Binds one frame to one editing session. The session needs the frame's window before the server
 * has said what to load in it, so the frame starts empty and navigates here once the server does.
 * Its window stays the same across that navigation, and every message is checked against it.
 */
export function createEditorAttachment({
  frame,
  backend,
  guard,
}: {
  frame: HTMLIFrameElement;
  backend: EditorBackendPort;
  guard: NavigationGuard;
}): Attachment {
  const host = frame.ownerDocument.defaultView;
  const editorWindow = frame.contentWindow;

  if (host === null || editorWindow === null) {
    throw new Error("An editor frame must be in the document before it's attached.");
  }

  const session = createEditorSession({
    backend,
    maxBytes: MAX_EDITOR_BYTES,
    autosave: { idleMs: 750, maxWaitMs: 5000 },
    messages: createBrowserEditorMessages({
      host,
      editorWindow,
      origin: host.location.origin,
    }),
  });

  let navigated = false;
  let release: (() => void) | null = null;

  const stopWatching = session.subscribe(() => {
    const { document, hasUnsavedChanges } = session.getSnapshot();

    if (hasUnsavedChanges && release === null) release = guard.hold();

    if (!hasUnsavedChanges && release !== null) {
      release();
      release = null;
    }

    if (document === null || navigated) return;
    navigated = true;

    const { assetUrl } = document;

    // Anything else stays unloaded, and the session reports the editor never becoming ready.
    if (isSameOriginPath(assetUrl)) frame.src = assetUrl;
  });

  function dispose() {
    host?.removeEventListener("pagehide", leaveDocument);
    stopWatching();
    session.dispose();
    release?.();
    release = null;
  }

  /**
   * Leaving the document ends the session, for the sake of the server's limit on open ones. Only
   * here, not at `beforeunload`: that only asks, and a person can answer no and keep working. A page
   * kept in the back/forward cache may come back with its work intact, so it's left alone. If it
   * never does, the session expires on the server like any other that couldn't say goodbye.
   */
  function leaveDocument(event: PageTransitionEvent) {
    if (!event.persisted) dispose();
  }

  host.addEventListener("pagehide", leaveDocument);

  return { session, dispose };
}

export type EditorAttachment = Attachment;
