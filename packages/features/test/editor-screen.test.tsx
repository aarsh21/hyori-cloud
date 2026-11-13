import { afterEach, describe, expect } from "bun:test";
import type {
  EditorBackendPort,
  EditorDocument,
  EditorSaveResult,
  FileEntry,
} from "@hyori-cloud/client-sdk";
import { DropdownMenu, DropdownMenuContent } from "@hyori-cloud/ui/components/dropdown-menu";
import { createNavigationGuard } from "#features/cloud/navigation-guard.ts";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import {
  createEditorAttachment,
  EDITOR_FRAME_SANDBOX,
} from "#features/editors/editor-attachment.ts";
import { createDestinationRequests } from "#features/editors/destination-requests.ts";
import { editorForFile } from "#features/editors/editor-files.ts";
import type { AvailableEditor } from "#features/editors/editor-files.ts";
import { DestinationDialog } from "#features/editors/react/destination-dialog.tsx";
import { EditorScreen } from "#features/editors/react/editor-screen.tsx";
import { OpenInEditorItem } from "#features/editors/react/open-in-editor-item.tsx";
import {
  act,
  ApiFailure,
  createFakeApi,
  deferred,
  fileEntry,
  fileList,
  fireEvent,
  folderEntry,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";
import type { FakeApi, RequestInput } from "#features-test/mounted.tsx";

const ASSET_URL = "/artcraft/wordcraft/0.14.0/index.html?host=parent";

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
  assetUrl: ASSET_URL,
} satisfies EditorDocument;

test("a cancelled destination keeps its filename through exit and uses the next request's name", async () => {
  const requests = createDestinationRequests();

  mount(
    <DestinationDialog
      requests={requests}
      destination={{ kind: "none" }}
      sessionId={DOCUMENT.sessionId}
    />,
    createFakeApi({}),
  );
  const options = { signal: new AbortController().signal };
  let choice: Promise<{ parentId: string | null } | null>;

  act(() => {
    choice = requests.choose({ name: "Quarterly report.docx", intent: "save-as" }, options);
  });
  const title = await screen.findByRole("heading", { name: "Save “Quarterly report.docx” to…" });

  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await choice!).toBeNull();
  expect(requests.getSnapshot()).toBeNull();
  expect(title.textContent).toBe("Save “Quarterly report.docx” to…");

  act(() => {
    choice = requests.choose({ name: "Budget.xlsx", intent: "save-as" }, options);
  });
  expect(await screen.findByRole("heading", { name: "Save “Budget.xlsx” to…" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(await choice!).toBeNull();
});

test("copy names follow the selected folder and refresh for the next copy", async () => {
  const requests = createDestinationRequests();
  let next = 7;

  const api = createFakeApi({
    "files.list": () => fileList([folderEntry({ id: "copies", name: "Copies" })]),
    "files.get": () => folderEntry({ id: "copies", name: "Copies" }),
    "editors.suggestCopyName": ({ parentId }) =>
      parentId === null ? "Budget (2).pptx" : `Budget (${next}).pptx`,
  });

  mount(
    <DestinationDialog
      requests={requests}
      destination={{ kind: "folder", folderId: null }}
      sessionId={DOCUMENT.sessionId}
    />,
    api,
  );
  const options = { signal: new AbortController().signal };
  let choice: ReturnType<typeof requests.choose>;

  act(() => {
    choice = requests.choose({ name: "Budget.pptx", intent: "save-as" }, options);
  });
  await screen.findByRole("heading", { name: "Save “Budget (2).pptx” to…" });
  fireEvent.click(await screen.findByRole("button", { name: "Copies" }));
  await screen.findByRole("heading", { name: "Save “Budget (7).pptx” to…" });
  fireEvent.click(screen.getByRole("button", { name: "Save here" }));
  expect(await choice!).toEqual({ parentId: "copies", name: "Budget (7).pptx" });
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  next = 8;
  act(() => {
    choice = requests.choose({ name: "Budget.pptx", intent: "save-as" }, options);
  });
  await screen.findByRole("heading", { name: "Save “Budget (2).pptx” to…" });
  fireEvent.click(await screen.findByRole("button", { name: "Copies" }));
  await screen.findByRole("heading", { name: "Save “Budget (8).pptx” to…" });
  fireEvent.click(screen.getByRole("button", { name: "Save here" }));
  expect(await choice!).toEqual({ parentId: "copies", name: "Budget (8).pptx" });
});

function mountedFrame() {
  const frame = document.createElement("iframe");
  frame.setAttribute("sandbox", EDITOR_FRAME_SANDBOX);

  document.body.append(frame);

  return frame;
}

function backendFor(
  overrides: Partial<EditorDocument> = {},
  save?: () => Promise<EditorSaveResult>,
) {
  const saves: string[] = [];

  const backend: EditorBackendPort = {
    open: async () => ({ ...DOCUMENT, ...overrides }),
    download: async () => new TextEncoder().encode("original"),
    save: async ({ output, saveId }) => {
      saves.push(`${output.intent}:${output.name}:${saveId.length > 0}`);

      return (await save?.()) ?? { status: "saved", revision: "4" };
    },
  };

  return { backend, saves };
}

type EditorMessage = {
  readonly type: string;
  readonly version?: string;
  readonly protocol?: number;
  readonly acknowledgements?: boolean;
  readonly maxBytes?: number;
  readonly dirty?: boolean;
  readonly openId?: string;
  readonly saveId?: string;
  readonly documentId?: string;
  readonly name?: string;
  readonly saveAs?: boolean;
  readonly bytes?: Uint8Array;
};

afterEach(() => {
  for (const frame of document.querySelectorAll("iframe")) frame.remove();
});

function fromEditor(editorWindow: Window | null, data: EditorMessage) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data,
      origin: "null",
      source: editorWindow,
    }),
  );
}

function attach(frame: HTMLIFrameElement, backend: EditorBackendPort) {
  const guard = createNavigationGuard();

  return {
    guard,
    attachment: createEditorAttachment({ frame, backend, guard, onReturn: () => {} }),
  };
}

// Captured before attaching. This DOM replaces a frame's window when it navigates, where a real
// browser keeps it. The session binds to the one it captured, so that's the one that must speak.
describe("attaching an editor to a frame", () => {
  test("the frame stays empty until the server says what to load, then loads exactly that", async () => {
    const frame = mountedFrame();
    const opening = deferred<EditorDocument>();

    const { attachment } = attach(frame, {
      ...backendFor().backend,
      open: () => opening.promise,
    });

    expect(frame.getAttribute("src")).toBeNull();

    opening.resolve(DOCUMENT);

    await waitFor(() => expect(frame.getAttribute("src")).toBe(ASSET_URL));
    attachment.dispose();
  });

  for (const assetUrl of [
    "https://elsewhere.example/editor.html",
    "//elsewhere.example/editor.html",
    "/\\elsewhere.example/editor.html",
    "javascript:alert(1)",
    "artcraft/wordcraft/index.html",
  ]) {
    test(`a descriptor pointing at ${assetUrl} never loads`, async () => {
      const frame = mountedFrame();
      const { attachment } = attach(frame, backendFor({ assetUrl }).backend);

      await waitFor(() => expect(attachment.session.getSnapshot().status).toBe("failed"));
      expect(frame.getAttribute("src")).toBeNull();
      attachment.dispose();
    });
  }

  test("a real document flows from the editor's ready message to its save", async () => {
    const frame = mountedFrame();
    const editorWindow = frame.contentWindow;
    const { backend, saves } = backendFor();
    const opened: EditorMessage[] = [];

    Object.defineProperty(editorWindow, "postMessage", {
      configurable: true,
      value: (message: EditorMessage) => opened.push(message),
    });

    const { attachment } = attach(frame, backend);

    await waitFor(() => expect(frame.getAttribute("src")).toBe(ASSET_URL));

    fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" });

    await waitFor(() => expect(attachment.session.getSnapshot().status).toBe("editing"));
    expect(opened).toHaveLength(1);

    fromEditor(editorWindow, {
      type: "wordcraft:save",
      name: "report.docx",
      saveAs: false,
      bytes: new TextEncoder().encode("edited"),
    });

    await waitFor(() => expect(saves).toEqual(["replace:report.docx:true"]));
    attachment.dispose();
  });

  test("a message from another window is ignored", async () => {
    const frame = mountedFrame();
    const other = mountedFrame();
    const { attachment } = attach(frame, backendFor().backend);

    await waitFor(() => expect(frame.getAttribute("src")).toBe(ASSET_URL));

    fromEditor(other.contentWindow, { type: "wordcraft:ready", version: "0.14.0" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(attachment.session.getSnapshot().status).toBe("opening");
    attachment.dispose();
  });

  test("unsaved work holds the guard until it's saved", async () => {
    const frame = mountedFrame();
    const editorWindow = frame.contentWindow;
    const { backend } = backendFor();

    Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

    const { guard, attachment } = attach(frame, backend);

    await waitFor(() => expect(frame.getAttribute("src")).toBe(ASSET_URL));
    fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" });
    await waitFor(() => expect(attachment.session.getSnapshot().status).toBe("editing"));

    expect(guard.isHeld()).toBe(false);

    fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true });
    await waitFor(() => expect(guard.isHeld()).toBe(true));

    fromEditor(editorWindow, {
      type: "wordcraft:save",
      name: "report.docx",
      saveAs: false,
      bytes: new TextEncoder().encode("edited"),
    });

    await waitFor(() => expect(guard.isHeld()).toBe(false));
    expect(attachment.session.getSnapshot().hasUnsavedChanges).toBe(false);
    attachment.dispose();
  });

  test("ending it stops the session first, and lets go of the guard", async () => {
    const frame = mountedFrame();
    const editorWindow = frame.contentWindow;
    const { backend } = backendFor();

    Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

    const { guard, attachment } = attach(frame, backend);

    await waitFor(() => expect(frame.getAttribute("src")).toBe(ASSET_URL));
    fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" });
    await waitFor(() => expect(attachment.session.getSnapshot().status).toBe("editing"));
    fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true });
    await waitFor(() => expect(guard.isHeld()).toBe(true));

    attachment.dispose();

    expect(attachment.session.getSnapshot().status).toBe("disposed");
    expect(guard.isHeld()).toBe(false);
  });

  test("a frame that isn't in the document is refused", () => {
    const frame = document.createElement("iframe");
    frame.setAttribute("sandbox", EDITOR_FRAME_SANDBOX);

    expect(() => attach(frame, backendFor().backend)).toThrow();
  });
});

const UPLOADING = {
  uploadId: "upload_1",
  chunkSize: 1024,
  totalParts: 1,
  parts: [],
  state: "uploading",
  fileId: null,
};

describe("the editor screen", () => {
  const OWNED = fileEntry({ id: "file_1", name: "report.docx", parentId: "folder_9" });

  function apiFor(
    handlers: Record<string, (input: RequestInput) => object | Promise<object>> = {},
  ) {
    return createFakeApi({
      "editors.open": () => DOCUMENT,
      "editors.download": () => ({
        url: "/api/storage/editors/session_1?revision=3",
        name: "report.docx",
        size: 10,
        mimeType: "application/octet-stream",
      }),
      "files.get": () => OWNED,
      "editors.suggestCopyName": (input) => String(input.name),
      ...handlers,
    });
  }

  function screenWith(api: FakeApi, onNavigate: (path: string) => void = () => {}) {
    const guard = createNavigationGuard();

    const view = mount(
      <CloudNavigationProvider
        location={{ section: "editor", fileId: "file_1" }}
        onNavigate={onNavigate}
        navigationGuard={guard}
      >
        <EditorScreen
          fileId="file_1"
          copyDestination={{ kind: "folder", folderId: null }}
          closePath={(parentId) => (parentId === null ? "/" : `/folders/${parentId}`)}
        />
      </CloudNavigationProvider>,
      api,
    );

    const frame = view.container.querySelector("iframe");

    if (frame === null) throw new Error("Expected the editor's frame.");

    const editorWindow = frame.contentWindow;

    Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });

    return { view, frame, guard, editorWindow };
  }

  async function ready(editorWindow: Window | null, version = "0.14.0", app = "wordcraft") {
    await screen.findByText(DOCUMENT.name);
    act(() => fromEditor(editorWindow, { type: `${app}:ready`, version }));
    await screen.findByText("All changes saved");
  }

  function save(
    editorWindow: Window | null,
    overrides: Pick<EditorMessage, "name" | "saveAs"> = {},
  ) {
    act(() =>
      fromEditor(editorWindow, {
        type: "wordcraft:save",
        name: "report.docx",
        saveAs: false,
        bytes: new TextEncoder().encode("edited"),
        ...overrides,
      }),
    );
  }

  test("opens behind progress, then shows the document's own name and state", async () => {
    const { editorWindow } = screenWith(apiFor());

    expect(screen.getByRole("status", { name: "Opening the editor" })).toBeTruthy();

    await ready(editorWindow);

    expect(screen.queryByRole("status", { name: "Opening the editor" })).toBeNull();
  });

  test("uses one frame for the whole lifetime, and offers the notices", async () => {
    const { view, frame, editorWindow } = screenWith(apiFor());

    await ready(editorWindow);

    expect(view.container.querySelector("iframe")).toBe(frame);
    fireEvent.click(screen.getByRole("button", { name: "Document options" }));
    expect((await screen.findByRole("menuitem", { name: "Notices" })).getAttribute("href")).toBe(
      "/artcraft/legal/RUNTIME-NOTICE-INDEX.md",
    );
  });

  test("editing shows as unsaved and warns the host, until it's really saved", async () => {
    const api = apiFor();
    const { guard, editorWindow } = screenWith(api);

    await ready(editorWindow);
    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true }));

    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    expect(guard.isHeld()).toBe(true);
  });

  test("a child reporting clean isn't taken as saved", async () => {
    const { guard, editorWindow } = screenWith(apiFor());

    await ready(editorWindow);
    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true }));
    await screen.findByText("Unsaved changes");
    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: false }));

    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    expect(guard.isHeld()).toBe(true);
  });

  test("a read-only document says so, and offers nothing that would save over it", async () => {
    const api = apiFor({
      "editors.open": () => ({ ...DOCUMENT, writable: false, replacementName: null }),
    });

    const { editorWindow } = screenWith(api);

    await screen.findByText(DOCUMENT.name);
    act(() => fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" }));

    expect(await screen.findByText("Read only")).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
  });

  test("a Save As asks where to put it, and cancelling keeps the work", async () => {
    const api = apiFor({
      "files.list": () => ({ items: [], nextCursor: null, breadcrumbs: [], folder: null }),
    });

    const { editorWindow, guard } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow, { name: "copy.docx", saveAs: true });

    expect(await screen.findByRole("heading", { name: "Save “copy.docx” to…" })).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Save “copy.docx” to…" })).toBeNull(),
    );
    expect(await screen.findByText("Not saved")).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
    expect(guard.isHeld()).toBe(true);
  });

  test("a PowerPoint file's first save asks for a folder, and never replaces the source", async () => {
    const version = "0.14.1-hyori-host.1";
    const name = "talk.pptx";

    const api = apiFor({
      "editors.open": () => ({
        ...DOCUMENT,
        app: "deckcraft",
        version,
        name,
        replacementName: null,
        outputFormats: [{ extension: ".deckcraft", kind: "document" }],
      }),
      "files.list": () => ({ items: [], nextCursor: null, breadcrumbs: [], folder: null }),
    });

    const { editorWindow } = screenWith(api);
    const posted: EditorMessage[] = [];

    Object.defineProperty(editorWindow, "postMessage", {
      configurable: true,
      value: (message: EditorMessage) => posted.push(message),
    });

    await screen.findByText(name);

    const deck = { protocol: 1, version };

    act(() =>
      fromEditor(editorWindow, {
        ...deck,
        type: "deckcraft:ready",
        acknowledgements: true,
        maxBytes: 64 * 1024 * 1024,
      }),
    );

    await waitFor(() => expect(posted.map(({ type }) => type)).toContain("deckcraft:open"));

    const openId = posted[0]?.openId ?? "";

    act(() =>
      fromEditor(editorWindow, {
        ...deck,
        type: "deckcraft:opened",
        name,
        openId,
        documentId: "1",
      }),
    );

    await screen.findByText("All changes saved");

    act(() =>
      fromEditor(editorWindow, {
        ...deck,
        type: "deckcraft:save",
        name: "talk.deckcraft",
        saveAs: false,
        bytes: new TextEncoder().encode("native"),
        saveId: `${openId}:1`,
        openId,
      }),
    );

    expect(await screen.findByRole("heading", { name: "Save “talk.deckcraft” to…" })).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
  });

  test("a read-only Save As asks where to go, saves there, and leaves the source alone", async () => {
    const saved = fileEntry({ id: "file_2", name: "copy.docx", parentId: null });

    const api = apiFor({
      "editors.open": () => ({ ...DOCUMENT, writable: false, replacementName: null }),
      "files.list": () => ({ items: [], nextCursor: null, breadcrumbs: [], folder: null }),
      "editors.prepareSave": () => UPLOADING,
      "uploads.status": () => UPLOADING,
      "uploads.part": () => ({ url: "/parts/1", method: "PUT", headers: {} }),
      "uploads.complete": () => saved,
      "editors.completeSave": () => ({ status: "saved", revision: "1", file: saved }),
    });

    const { editorWindow, guard } = screenWith(api);

    await screen.findByText(DOCUMENT.name);
    act(() => fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" }));
    await screen.findByText("Read only");

    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true }));
    save(editorWindow, { name: "copy.docx", saveAs: true });

    expect(await screen.findByRole("heading", { name: "Save “copy.docx” to…" })).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Save here" }));

    await waitFor(() => expect(api.callsTo("editors.completeSave")).toHaveLength(1));

    const [prepared] = api.callsTo("editors.prepareSave");

    expect(prepared?.input.intent).toBe("save-as");
    expect(prepared?.input.expectedRevision).toBe(DOCUMENT.revision);
    expect(prepared?.input.destination).toEqual({ parentId: null });

    // Still the same read-only document: the copy became a separate file.
    expect(await screen.findByText("Read only")).toBeTruthy();
    await waitFor(() => expect(guard.isHeld()).toBe(false));
  });

  test("a read-only document's ordinary Save becomes a copy, never a replacement", async () => {
    const api = apiFor({
      "editors.open": () => ({ ...DOCUMENT, writable: false, replacementName: null }),
      "files.list": () => ({ items: [], nextCursor: null, breadcrumbs: [], folder: null }),
    });

    const { editorWindow } = screenWith(api);

    await screen.findByText(DOCUMENT.name);
    act(() => fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" }));
    await screen.findByText("Read only");

    save(editorWindow);

    expect(await screen.findByRole("heading", { name: "Save “report.docx” to…" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: /^Save/ })).toBeNull());
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
  });

  test("a server conflict keeps the editor, and offers the latest rather than overwriting", async () => {
    const api = apiFor({
      "editors.prepareSave": () => {
        throw new ApiFailure("resource.conflict");
      },
    });

    const { editorWindow, guard } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow);

    expect(await screen.findByText("Not saved: changed elsewhere")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open latest version" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Download my version" })).toBeTruthy();
    expect(document.querySelector("iframe")).not.toBeNull();
    expect(guard.isHeld()).toBe(true);
    expect(screen.queryByRole("button", { name: "Retry save" })).toBeNull();
  });

  test("opening the latest after a conflict warns, then starts a new session", async () => {
    const api = apiFor({
      "editors.prepareSave": () => {
        throw new ApiFailure("resource.conflict");
      },
    });

    const { editorWindow } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow);

    expect(await screen.findByText("This file was changed somewhere else")).toBeTruthy();
    // Nothing typed under the cover could be saved, so the editor takes no input there.
    expect(document.querySelector("iframe")?.hasAttribute("inert")).toBe(true);
    fireEvent.click(await screen.findByRole("button", { name: "Open latest version" }));

    expect(await screen.findByText("Leave your version behind?")).toBeTruthy();
    expect(api.callsTo("editors.open")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Reopen without it" }));

    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(2));
  });

  test("a failed save can be retried, with the same bytes and the same save", async () => {
    let attempts = 0;

    const api = apiFor({
      "editors.prepareSave": () => {
        attempts += 1;
        throw new ApiFailure("service.unavailable");
      },
    });

    const { editorWindow } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow);

    fireEvent.click(await screen.findByRole("button", { name: "Retry save" }));

    await waitFor(() => expect(attempts).toBeGreaterThanOrEqual(2));

    const [first, second] = api.callsTo("editors.prepareSave");

    expect(second?.input.saveId).toBe(first?.input.saveId);
    expect(second?.input.sha256).toBe(first?.input.sha256);
  });

  test("losing access covers the editor and keeps what can be recovered", async () => {
    const api = apiFor({
      "editors.prepareSave": () => {
        throw new ApiFailure("auth.required");
      },
    });

    const { editorWindow } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow);

    expect(await screen.findByText("You no longer have access to this file")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Download my version" }).length).toBeGreaterThan(
      0,
    );
  });

  test("an unavailable editor says so plainly, with a way back", async () => {
    const api = apiFor({
      "editors.open": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    screenWith(api);

    expect(await screen.findByText("Editing isn’t available right now")).toBeTruthy();
    expect(screen.getByText(/Your file hasn’t changed/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  for (const [code, title] of [
    ["resource.conflict", "Too many documents are open"],
    ["input.invalid", "This file can’t be opened in the editor"],
  ] as const) {
    test(`opening refused with ${code} says why`, async () => {
      screenWith(
        apiFor({
          "editors.open": () => {
            throw new ApiFailure(code);
          },
        }),
      );

      expect(await screen.findByText(title)).toBeTruthy();
    });
  }

  test("losing Edit mid-session turns the editor read-only rather than ending it", async () => {
    const api = apiFor({
      "editors.prepareSave": () => {
        throw new ApiFailure("access.denied");
      },
    });

    const { editorWindow } = screenWith(api);

    await ready(editorWindow);
    save(editorWindow);

    await waitFor(() =>
      expect(screen.queryByText("You no longer have access to this file")).toBeNull(),
    );
    expect((await screen.findAllByText(/Save a copy|Read only/)).length).toBeGreaterThan(0);
  });

  test("closing with nothing unsaved goes straight back to the file's folder", async () => {
    const paths: string[] = [];
    const { editorWindow, guard } = screenWith(apiFor(), (path) => paths.push(path));

    await ready(editorWindow);
    await waitFor(() => expect(paths).toHaveLength(0));
    await new Promise((resolve) => setTimeout(resolve, 10));

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);

    await waitFor(() => expect(paths).toEqual(["/folders/folder_9"]));
    expect(guard.isHeld()).toBe(false);
  });

  test("closing with unsaved work warns, and keeping going loses nothing", async () => {
    const paths: string[] = [];
    const { editorWindow, guard } = screenWith(apiFor(), (path) => paths.push(path));

    await ready(editorWindow);
    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true }));
    await screen.findByText("Unsaved changes");

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);

    expect(await screen.findByText("Close without saving?")).toBeTruthy();
    expect(paths).toEqual([]);

    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));

    await waitFor(() => expect(screen.queryByText("Close without saving?")).toBeNull());
    expect(guard.isHeld()).toBe(true);
    expect(paths).toEqual([]);
  });

  test("discarding ends the session before leaving", async () => {
    const paths: string[] = [];
    const { editorWindow, guard } = screenWith(apiFor(), (path) => paths.push(path));

    await ready(editorWindow);
    act(() => fromEditor(editorWindow, { type: "wordcraft:dirty", dirty: true }));
    await screen.findByText("Unsaved changes");

    fireEvent.click(screen.getAllByRole("button", { name: "Close" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Discard changes" }));

    await waitFor(() => expect(paths).toHaveLength(1));
    expect(guard.isHeld()).toBe(false);
  });
});

describe("offering the editor", () => {
  const DOCX = fileEntry({ id: "file_1", name: "report.docx" });

  const WORD: AvailableEditor = {
    app: "wordcraft",
    version: "0.14.0",
    inputExtensions: [".docx"],
  };

  function menuItem(entry: FileEntry) {
    return (
      <CloudNavigationProvider
        location={{ section: "files", folderId: null }}
        onNavigate={() => {}}
      >
        <DropdownMenu open>
          <DropdownMenuContent>
            <OpenInEditorItem entry={entry} />
          </DropdownMenuContent>
        </DropdownMenu>
      </CloudNavigationProvider>
    );
  }

  test("a file the server's available editors accept gets the entry", async () => {
    mount(menuItem(DOCX), createFakeApi({ "editors.available": () => ({ apps: [WORD] }) }));

    expect(await screen.findByRole("menuitem", { name: "Open in editor" })).toBeTruthy();
  });

  test("a server offering no editors shows nothing", async () => {
    const api = createFakeApi({ "editors.available": () => ({ apps: [] }) });

    mount(menuItem(DOCX), api);

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    expect(screen.queryByRole("menuitem", { name: "Open in editor" })).toBeNull();
  });

  test("a file no available editor accepts shows nothing", async () => {
    const api = createFakeApi({ "editors.available": () => ({ apps: [WORD] }) });

    mount(menuItem(fileEntry({ id: "file_2", name: "a.xlsx" })), api);

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    expect(screen.queryByRole("menuitem", { name: "Open in editor" })).toBeNull();
  });

  test("while it's unknown, or if it fails, nothing is offered", async () => {
    const api = createFakeApi({
      "editors.available": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    mount(menuItem(DOCX), api);

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    expect(screen.queryByRole("menuitem", { name: "Open in editor" })).toBeNull();
  });

  test("many rows share one read", async () => {
    const api = createFakeApi({ "editors.available": () => ({ apps: [WORD] }) });

    mount(
      <CloudNavigationProvider
        location={{ section: "files", folderId: null }}
        onNavigate={() => {}}
      >
        <DropdownMenu open>
          <DropdownMenuContent>
            {["a", "b", "c", "d"].map((name) => (
              <OpenInEditorItem key={name} entry={fileEntry({ id: name, name: `${name}.docx` })} />
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </CloudNavigationProvider>,
      api,
    );

    await waitFor(() => expect(screen.getAllByRole("menuitem")).toHaveLength(4));
    expect(api.callsTo("editors.available")).toHaveLength(1);
  });

  test("the choice follows the server's list, never a built-in one", () => {
    const apps = [WORD];

    expect(editorForFile("report.docx", apps)?.app).toBe("wordcraft");
    expect(editorForFile("REPORT.DOCX", apps)?.app).toBe("wordcraft");
    expect(editorForFile("sheet.xlsx", apps)).toBeUndefined();
    expect(editorForFile("docx", apps)).toBeUndefined();
    expect(editorForFile("a.docx.txt", apps)).toBeUndefined();
  });
});
