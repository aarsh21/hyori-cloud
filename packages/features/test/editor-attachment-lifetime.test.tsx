import { afterEach, describe, expect, spyOn } from "bun:test";
import type { EditorBackendPort, EditorDocument } from "@hyori-cloud/client-sdk";
import { createNavigationGuard } from "#features/cloud/navigation-guard.ts";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import { createEditorAttachment } from "#features/editors/editor-attachment.ts";
import { EditorScreen } from "#features/editors/react/editor-screen.tsx";
import {
  act,
  ApiFailure,
  createFakeApi,
  fileEntry,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const DOCUMENT = {
  sessionId: "session_1",
  app: "wordcraft",
  bridge: "upstream-host-parent",
  protocol: null,
  version: "0.14.0",
  name: "report.docx",
  revision: "3",
  writable: true,
  maxBytes: 1024 * 1024,
  replacementName: "report.docx",
  outputFormats: [{ extension: ".docx", kind: "document" }],
  assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
} satisfies EditorDocument;

afterEach(() => {
  for (const frame of document.querySelectorAll("iframe")) frame.remove();
});

type EditorMessage = {
  readonly type: string;
  readonly version?: string;
  readonly dirty?: boolean;
  readonly name?: string;
  readonly saveAs?: boolean;
  readonly bytes?: Uint8Array;
};

function leaveDocument({ persisted }: { persisted: boolean }) {
  act(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted })));
}

/** The person is asked and says no: the only thing the page ever sees is this event. */
function refuseToLeave() {
  const asking = new Event("beforeunload", { cancelable: true });

  act(() => window.dispatchEvent(asking));
  asking.preventDefault();
}

describe("how long an attachment lives", () => {
  function attached() {
    const frame = document.createElement("iframe");
    const closes: string[] = [];
    const guard = createNavigationGuard();

    document.body.append(frame);

    const backend: EditorBackendPort = {
      open: async () => DOCUMENT,
      download: async () => new TextEncoder().encode("original"),
      save: async () => ({ status: "saved", revision: "4" }),
      close: async () => {
        closes.push("closed");
      },
    };

    // Captured first: this DOM replaces a frame's window when it navigates, where a browser doesn't.
    const editorWindow = frame.contentWindow;

    Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

    const attachment = createEditorAttachment({ frame, backend, guard });

    return { attachment, closes, guard, frame, editorWindow };
  }

  const status = ({ attachment }: ReturnType<typeof attached>) =>
    attachment.session.getSnapshot().status;

  test("really leaving the document ends the session, once", () => {
    const opened = attached();

    leaveDocument({ persisted: false });
    leaveDocument({ persisted: false });

    expect(status(opened)).toBe("disposed");
    expect(opened.closes).toEqual(["closed"]);
  });

  test("leaving lets go of the unsaved-work warning with the session", async () => {
    const opened = attached();

    const fromEditor = (data: { type: string; version?: string; dirty?: boolean }) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data,
            origin: window.location.origin,
            source: opened.editorWindow,
          }),
        ),
      );

    await waitFor(() => expect(opened.frame.getAttribute("src")).toBe(DOCUMENT.assetUrl));
    fromEditor({ type: "wordcraft:ready", version: "0.14.0" });
    await waitFor(() => expect(status(opened)).toBe("editing"));
    fromEditor({ type: "wordcraft:dirty", dirty: true });
    expect(opened.guard.isHeld()).toBe(true);

    refuseToLeave();
    expect(opened.guard.isHeld()).toBe(true);
    expect(opened.closes).toEqual([]);

    leaveDocument({ persisted: false });
    expect(opened.guard.isHeld()).toBe(false);
    expect(opened.closes).toEqual(["closed"]);
  });

  test("answering no to the prompt leaves everything running", () => {
    const opened = attached();

    refuseToLeave();

    expect(status(opened)).not.toBe("disposed");
    expect(opened.closes).toEqual([]);
    opened.attachment.dispose();
  });

  test("a page kept for the back button keeps its live work", () => {
    const opened = attached();

    leaveDocument({ persisted: true });

    expect(status(opened)).not.toBe("disposed");
    expect(opened.closes).toEqual([]);
    opened.attachment.dispose();
  });

  test("a page that came back still ends its session when it's really left", () => {
    const opened = attached();

    leaveDocument({ persisted: true });
    leaveDocument({ persisted: false });

    expect(status(opened)).toBe("disposed");
    expect(opened.closes).toEqual(["closed"]);
  });

  test("disposing first leaves nothing for a later page exit to do", () => {
    const opened = attached();

    opened.attachment.dispose();
    opened.attachment.dispose();
    leaveDocument({ persisted: false });

    expect(opened.closes).toEqual(["closed"]);
  });
});

describe("the mounted editor's session", () => {
  test("unsaved work and a refused exit send nothing, and really leaving ends it once", async () => {
    const { api, fromEditor } = await opened();

    await editing(fromEditor);
    refuseToLeave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("editors.close")).toHaveLength(0);
    expect(screen.getByText("Unsaved changes")).toBeTruthy();

    leaveDocument({ persisted: false });

    await waitFor(() => expect(api.callsTo("editors.close")).toHaveLength(1));
  });

  test("cleanup that fails still says so, which nothing here hides", async () => {
    const reported = spyOn(console, "error").mockImplementation(() => {});

    try {
      const { api, view } = await opened(
        apiFor({
          "editors.close": () => {
            throw new ApiFailure("service.unavailable");
          },
        }),
      );

      view.rerender(<div />);

      await waitFor(() => expect(api.callsTo("editors.close")).toHaveLength(1));
      await waitFor(() =>
        expect(reported).toHaveBeenCalledWith(
          "Editor session cleanup could not be confirmed; server expiry remains active.",
        ),
      );
    } finally {
      reported.mockRestore();
    }
  });

  test("opening the latest starts on a new backend, not the one the old session retired", async () => {
    const { api, fromEditor } = await opened(
      apiFor({
        "editors.prepareSave": () => {
          throw new ApiFailure("resource.conflict");
        },
      }),
    );

    await editing(fromEditor);
    fromEditor({
      type: "wordcraft:save",
      name: "report.docx",
      saveAs: false,
      bytes: new TextEncoder().encode("edited"),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Open latest version" }));
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(2));
    await waitFor(() => expect(api.callsTo("editors.download")).toHaveLength(2));
    expect(screen.queryByText("This document couldn’t be opened in the editor")).toBeNull();
  });

  function apiFor(handlers: Parameters<typeof createFakeApi>[0] = {}) {
    return createFakeApi({
      "editors.open": () => DOCUMENT,
      "editors.download": () => ({
        url: "/api/storage/editors/session_1?revision=3",
        name: "report.docx",
        size: 10,
        mimeType: "application/octet-stream",
      }),
      "files.get": () => fileEntry({ id: "file_1", name: "report.docx", parentId: null }),
      ...handlers,
    });
  }

  async function opened(api = apiFor()) {
    const view = mount(
      <CloudNavigationProvider
        location={{ section: "editor", fileId: "file_1" }}
        onNavigate={() => {}}
        navigationGuard={createNavigationGuard()}
      >
        <EditorScreen
          fileId="file_1"
          copyDestination={{ kind: "folder", folderId: null }}
          closePath={() => "/"}
        />
      </CloudNavigationProvider>,
      api,
    );

    const frame = view.container.querySelector("iframe");

    if (frame === null) throw new Error("Expected the editor's frame.");

    // Captured first: this DOM replaces a frame's window when it navigates, where a browser doesn't.
    const editorWindow = frame.contentWindow;

    Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

    await screen.findByText(DOCUMENT.name);

    const fromEditor = (data: EditorMessage) =>
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            data,
            origin: window.location.origin,
            source: editorWindow,
          }),
        ),
      );

    return { api, view, fromEditor };
  }

  async function editing(fromEditor: (data: EditorMessage) => void) {
    fromEditor({ type: "wordcraft:ready", version: "0.14.0" });
    await screen.findByText("All changes saved");
    fromEditor({ type: "wordcraft:dirty", dirty: true });
    await screen.findByText("Unsaved changes");
  }

  test("moving elsewhere in the app ends it, and a later page exit doesn't again", async () => {
    const { api, view } = await opened();

    view.rerender(<div />);

    await waitFor(() => expect(api.callsTo("editors.close")).toHaveLength(1));
    leaveDocument({ persisted: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("editors.close")).toHaveLength(1);
  });

  test("Close ends it once, though the frame also goes away", async () => {
    const { api } = await opened();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(api.callsTo("editors.close")).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("editors.close")).toHaveLength(1);
  });

  test("reloading ends it, and answering no to the prompt first doesn't", async () => {
    const { api } = await opened();

    refuseToLeave();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(api.callsTo("editors.close")).toHaveLength(0);
    expect(document.querySelector("iframe")).not.toBeNull();

    leaveDocument({ persisted: false });

    await waitFor(() => expect(api.callsTo("editors.close")).toHaveLength(1));
  });
});
