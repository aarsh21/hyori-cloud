import { afterEach, describe, expect } from "bun:test";
import type { FileEntry } from "@hyori-cloud/client-sdk";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
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
  VIEWER_ACCESS,
  waitFor,
} from "#features-test/mounted.tsx";
import type { FakeApi, RequestInput } from "#features-test/mounted.tsx";

const EDITOR = { ...VIEWER_ACCESS, canEdit: true };

const FOLDER = folderEntry({ id: "folder_s", name: "Trip", access: EDITOR });

const INSIDE = fileEntry({
  id: "file_s",
  name: "notes.docx",
  parentId: "folder_s",
  access: EDITOR,
});

const NESTED = fileEntry({ id: "file_n", name: "deep.docx", parentId: "folder_n", access: EDITOR });
const LONE = fileEntry({ id: "file_l", name: "lone.docx", parentId: null, access: EDITOR });
const WORD = { app: "wordcraft", version: "0.14.0", inputExtensions: [".docx"] };

const DOCUMENT = {
  sessionId: "session_1",
  app: "wordcraft",
  bridge: "upstream-host-parent",
  protocol: null,
  version: "0.14.0",
  name: "notes.docx",
  revision: "3",
  writable: true,
  maxBytes: 1024 * 1024,
  replacementName: "notes.docx",
  outputFormats: [{ extension: ".docx", kind: "document" }],
  assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
};

function share(item: FileEntry | null, role = "editor") {
  return {
    share: {
      id: "share_1",
      itemId: "folder_s",
      role,
      recipientId: null,
      recipient: null,
      public: true,
      expiresAt: null,
      passwordProtected: item === null,
      revokedAt: null,
      url: null,
    },
    item,
    requiresPassword: item === null,
  };
}

type Handlers = Record<string, (input: RequestInput) => object | string | Promise<object | string>>;

// This DOM replaces a frame's window when it navigates, where a real browser keeps it. So the server
// holds its answer until a test has the window the session bound to, which is what must speak.
let openGate = deferred<void>();

async function afterWindowCaptured<Value>(value: Value) {
  await openGate.promise;

  return value;
}

afterEach(() => openGate.resolve());

function apiFor(item: FileEntry, handlers: Handlers = {}) {
  openGate = deferred<void>();

  return createFakeApi({
    "shares.resolve": () => share(item),
    "editors.available": () => ({ apps: [WORD] }),
    "editors.open": () => afterWindowCaptured(DOCUMENT),
    "editors.download": () => ({
      url: "/api/storage/editors/session_1?revision=3",
      name: "notes.docx",
      size: 10,
      mimeType: "application/octet-stream",
    }),
    "files.get": ({ id }) => [INSIDE, NESTED, LONE].find((file) => file.id === id) ?? INSIDE,
    "files.list": () => fileList([INSIDE], FOLDER, [{ id: FOLDER.id, name: FOLDER.name }]),
    "editors.suggestCopyName": (input) => String(input.name),
    ...handlers,
  });
}

/** The host's router in miniature: a path that changes when the screen asks, and on request. */
function mountAt(initial: string, api: FakeApi) {
  const visited: string[] = [];

  const screenAt = (path: string) => (
    <CloudScreen
      path={path}
      onNavigate={(next) => {
        visited.push(next);
        view.rerender(screenAt(next));
      }}
    />
  );

  const view = mount(screenAt(initial), api);

  return { view, visited, go: (path: string) => view.rerender(screenAt(path)) };
}

async function openLink() {
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
}

function frame(container: HTMLElement) {
  return container.querySelector("iframe");
}

type EditorMessage = {
  readonly type: string;
  readonly version?: string;
  readonly name?: string;
  readonly saveAs?: boolean;
  readonly bytes?: Uint8Array;
};

function fromEditor(editorWindow: Window | null, data: EditorMessage) {
  window.dispatchEvent(new MessageEvent("message", { data, origin: "null", source: editorWindow }));
}

/** Attaches to the frame as soon as it exists, because this DOM replaces its window on navigation. */
async function attachedEditor(container: HTMLElement) {
  await waitFor(() => expect(frame(container)).not.toBeNull());

  const editorWindow = frame(container)?.contentWindow ?? null;

  Object.defineProperty(editorWindow, "postMessage", { configurable: true, value: () => {} });
  openGate.resolve();

  return editorWindow;
}

async function editorReady(editorWindow: Window | null, name = "notes.docx") {
  await screen.findByText(name);
  act(() => fromEditor(editorWindow, { type: "wordcraft:ready", version: "0.14.0" }));
}

describe("the editor under a public link", () => {
  test("opening the path directly asks to open the link, never to sign in", async () => {
    const api = apiFor(FOLDER);

    mountAt("/share/token_1/edit/file_s", api);

    expect(await screen.findByRole("button", { name: "Open" })).toBeTruthy();
    expect(screen.queryByText(/Sign in/i)).toBeNull();
    expect(api.callsTo("auth.status")).toHaveLength(0);
    expect(api.callsTo("editors.open")).toHaveLength(0);
    expect(api.callsTo("shares.resolve")).toHaveLength(0);
  });

  test("after opening the link, the editor opens the file through it", async () => {
    const api = apiFor(FOLDER);
    const { view } = mountAt("/share/token_1/edit/file_s", api);

    await openLink();

    const editorWindow = await attachedEditor(view.container);

    await editorReady(editorWindow);

    expect(api.callsTo("shares.resolve")).toEqual([
      { operation: "shares.resolve", input: { token: "token_1" } },
    ]);
    expect(api.callsTo("editors.open")[0]?.input).toEqual({ id: "file_s" });
    expect(api.callsTo("auth.status")).toHaveLength(0);
    expect(await screen.findByText("All changes saved")).toBeTruthy();
  });

  test("a password link asks for it first, and then opens the editor", async () => {
    const api = apiFor(FOLDER, {
      "shares.resolve": () => share(null),
      "shares.unlock": () => share(FOLDER),
    });

    const { view } = mountAt("/share/token_1/edit/file_s", api);

    await openLink();
    expect(await screen.findByText("This link needs a password")).toBeTruthy();
    expect(api.callsTo("editors.open")).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "synthetic words" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(frame(view.container)).not.toBeNull());
    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(1));
  });

  test("the folder's row menu goes to the link's own editor path, with the same grant", async () => {
    const api = apiFor(FOLDER);
    const { visited, view } = mountAt("/share/token_1", api);

    await openLink();

    fireEvent.click(await screen.findByRole("button", { name: "Actions for notes.docx" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Open in editor" }));

    await waitFor(() => expect(visited).toEqual(["/share/token_1/edit/file_s"]));
    await waitFor(() => expect(frame(view.container)).not.toBeNull());
    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(1));
    expect(api.callsTo("shares.resolve")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Open" })).toBeNull();
  });

  test("many rows in a folder share one availability read", async () => {
    const files = ["a", "b", "c"].map((name) =>
      fileEntry({ id: name, name: `${name}.docx`, parentId: FOLDER.id, access: EDITOR }),
    );

    const api = apiFor(FOLDER, { "files.list": () => fileList(files, FOLDER, []) });

    mountAt("/share/token_1", api);

    await openLink();
    await screen.findByText("a.docx");

    for (const name of ["a", "b", "c"]) {
      fireEvent.click(screen.getByRole("button", { name: `Actions for ${name}.docx` }));
      await screen.findByRole("menuitem", { name: "Open in editor" });
      fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menuitem")).toBeNull());
    }

    expect(api.callsTo("editors.available")).toHaveLength(1);
    expect(api.callsTo("editors.open")).toHaveLength(0);
  });

  test("with no available editors, a link offers none", async () => {
    const api = apiFor(LONE, { "editors.available": () => ({ apps: [] }) });

    mountAt("/share/token_1", api);

    await openLink();
    await screen.findByText("lone.docx");
    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));

    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
  });

  test("a link to one file offers it there, and leaves its own actions in place", async () => {
    const api = apiFor(LONE);
    const { visited } = mountAt("/share/token_1", api);

    await openLink();

    fireEvent.click(await screen.findByRole("button", { name: "Open in editor" }));

    await waitFor(() => expect(visited).toEqual(["/share/token_1/edit/file_l"]));
  });

  test("a file the link can neither download nor edit isn't offered", async () => {
    const noAccess = fileEntry({
      id: "file_x",
      name: "secret.docx",
      access: { ...VIEWER_ACCESS, canDownload: false },
    });

    const api = apiFor(noAccess);

    mountAt("/share/token_1", api);

    await openLink();
    await screen.findByText("secret.docx");
    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));

    expect(screen.queryByRole("button", { name: "Open in editor" })).toBeNull();
  });

  test("a Viewer link opens read-only", async () => {
    const api = apiFor(FOLDER, {
      "shares.resolve": () => share(FOLDER, "viewer"),
      "editors.open": () =>
        afterWindowCaptured({ ...DOCUMENT, writable: false, replacementName: null }),
    });

    const { view } = mountAt("/share/token_1/edit/file_s", api);

    await openLink();

    const editorWindow = await attachedEditor(view.container);

    await editorReady(editorWindow);

    expect(await screen.findByText("Read only")).toBeTruthy();
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
  });

  test("the server refusing the file says so, with a way back to the link", async () => {
    const api = apiFor(FOLDER, {
      "editors.open": () => {
        throw new ApiFailure("access.denied");
      },
    });

    const { visited } = mountAt("/share/token_1/edit/file_s", api);

    await openLink();

    expect(await screen.findByText("You don’t have access to this file")).toBeTruthy();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);

    await waitFor(() => expect(visited).toEqual(["/share/token_1"]));
    expect(screen.queryByText(/Sign in/i)).toBeNull();
  });
});

describe("leaving the editor under a link", () => {
  async function ready(path: string, api: FakeApi) {
    const mounted = mountAt(path, api);

    await openLink();

    const editorWindow = await attachedEditor(mounted.view.container);

    await editorReady(editorWindow);
    await screen.findByText("All changes saved");

    return { ...mounted, editorWindow };
  }

  test("Close from a file at the folder's top goes back to the link's root", async () => {
    const { visited } = await ready("/share/token_1/edit/file_s", apiFor(FOLDER));

    await waitFor(() => expect(screen.getByRole("button", { name: "Close" })).toBeTruthy());
    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(visited).toEqual(["/share/token_1"]));
  });

  test("Close from a nested file goes back to the folder it's in", async () => {
    const api = apiFor(FOLDER, {
      "editors.open": () => afterWindowCaptured({ ...DOCUMENT, name: "deep.docx" }),
    });

    const { view, visited } = mountAt("/share/token_1/edit/file_n", api);

    await openLink();

    const editorWindow = await attachedEditor(view.container);

    await editorReady(editorWindow, "deep.docx");
    await screen.findByText("All changes saved");
    await waitFor(() => expect(api.callsTo("files.get").length).toBeGreaterThan(0));
    await new Promise((resolve) => setTimeout(resolve, 20));

    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(visited).toEqual(["/share/token_1/folder_n"]));
  });

  test("Close from a one-file link goes back to the link", async () => {
    const { visited } = await ready("/share/token_1/edit/file_l", apiFor(LONE));

    await new Promise((resolve) => setTimeout(resolve, 20));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    await waitFor(() => expect(visited).toEqual(["/share/token_1"]));
  });

  test("leaving ends the session and removes the frame, and keeps the opened link", async () => {
    const api = apiFor(FOLDER);
    const { view, go, editorWindow } = await ready("/share/token_1/edit/file_s", api);

    go("/share/token_1");

    await waitFor(() => expect(frame(view.container)).toBeNull());
    expect(await screen.findByText("notes.docx")).toBeTruthy();
    expect(api.callsTo("shares.resolve")).toHaveLength(1);

    // A message from the old frame no longer does anything.
    act(() =>
      fromEditor(editorWindow, {
        type: "wordcraft:save",
        name: "notes.docx",
        saveAs: false,
        bytes: new TextEncoder().encode("late"),
      }),
    );

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
  });

  test("coming back makes a new session, never a replay into the old one", async () => {
    const api = apiFor(FOLDER);
    const { view, go } = await ready("/share/token_1/edit/file_s", api);

    go("/share/token_1");
    await waitFor(() => expect(frame(view.container)).toBeNull());

    go("/share/token_1/edit/file_s");

    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(2));
    expect(api.callsTo("shares.resolve")).toHaveLength(1);
  });

  test("a different link gets a fresh start, with nothing carried over", async () => {
    const api = apiFor(FOLDER);
    const { view, go } = await ready("/share/token_1/edit/file_s", api);

    go("/share/token_2/edit/file_s");

    await waitFor(() => expect(frame(view.container)).toBeNull());
    expect(await screen.findByRole("button", { name: "Open" })).toBeTruthy();
  });
});

describe("saving a copy through a link", () => {
  async function askForCopy(api: FakeApi, path: string) {
    const { view } = mountAt(path, api);

    await openLink();

    const editorWindow = await attachedEditor(view.container);

    await editorReady(editorWindow);
    await screen.findByText("All changes saved");

    act(() =>
      fromEditor(editorWindow, {
        type: "wordcraft:save",
        name: "copy.docx",
        saveAs: true,
        bytes: new TextEncoder().encode("edited"),
      }),
    );

    return screen.findByRole("heading", { name: "Save “copy.docx” to…" });
  }

  test("a folder link starts from its own folder, and can't go above it", async () => {
    const api = apiFor(FOLDER, { "editors.prepareSave": () => ({}) });

    await askForCopy(api, "/share/token_1/edit/file_s");

    await waitFor(() => expect(api.callsTo("files.list").at(-1)?.input.parentId).toBe(FOLDER.id));
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Save here" }));

    await waitFor(() => expect(api.callsTo("editors.prepareSave")).toHaveLength(1));
    expect(api.callsTo("editors.prepareSave")[0]?.input.destination).toEqual({
      parentId: FOLDER.id,
    });
  });

  test("a one-file link says there's nowhere to put it, and keeps the work", async () => {
    const api = apiFor(LONE);

    await askForCopy(api, "/share/token_1/edit/file_l");

    expect(screen.getByText(/only shares one file/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save here" })).toBeNull();

    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);

    await waitFor(() =>
      expect(screen.queryByRole("heading", { name: "Save “copy.docx” to…" })).toBeNull(),
    );
    expect(api.callsTo("editors.prepareSave")).toHaveLength(0);
    expect(await screen.findByText("Not saved")).toBeTruthy();
    // Giving up on the copy keeps its bytes for download and lets the source keep saving.
    fireEvent.click(screen.getByRole("button", { name: "Don’t save copy" }));
    await waitFor(() => expect(screen.queryByText("Not saved")).toBeNull());
    expect(screen.queryByRole("menuitem", { name: "Save a copy…" })).toBeNull();
  });
});
