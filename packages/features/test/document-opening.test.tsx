import { describe, expect } from "bun:test";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
import {
  createFakeApi,
  deferred,
  fileEntry,
  fileList,
  fireEvent,
  folderEntry,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const DOCUMENT = fileEntry({ id: "doc_click_1", name: "Synthetic brief.docx" });
const OTHER = fileEntry({ id: "doc_click_2", name: "Synthetic notes.txt" });
const WORD = { app: "wordcraft", version: "0.14.0", inputExtensions: [".docx"] };

function previewFor(entry: typeof DOCUMENT) {
  return {
    url: `/synthetic-preview/${entry.id}`,
    name: entry.name,
    size: entry.size,
    mimeType: entry.mimeType,
  };
}

function setup(apps: readonly (typeof WORD)[] = [WORD]) {
  const paths: string[] = [];

  const api = createFakeApi({
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
    "files.list": () => fileList([DOCUMENT, OTHER]),
    "editors.available": () => ({ apps }),
    "files.preview": ({ id }) => previewFor(id === DOCUMENT.id ? DOCUMENT : OTHER),
    "files.download": () => ({
      url: "/synthetic-download",
      name: DOCUMENT.name,
      size: DOCUMENT.size,
      mimeType: DOCUMENT.mimeType,
    }),
  });

  mount(<CloudScreen path="/" onNavigate={(path) => paths.push(path)} />, api);

  return { api, paths };
}

async function documentTarget() {
  return screen.findByRole("button", { name: new RegExp(`^${DOCUMENT.name}`) });
}

describe("the document's primary target", () => {
  test("one click opens the server's available editor instead of downloading", async () => {
    const { api, paths } = setup();
    const target = await documentTarget();

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    fireEvent.click(target);

    expect(paths).toEqual(["/edit/doc_click_1"]);
    expect(api.callsTo("files.download")).toHaveLength(0);
    expect(api.callsTo("editors.open")).toHaveLength(0);
  });

  for (const modifier of ["shiftKey", "ctrlKey", "metaKey", "altKey"]) {
    test(`${modifier} does not accidentally open or download`, async () => {
      const { api, paths } = setup();
      const target = await documentTarget();

      fireEvent.click(target, { [modifier]: true });

      expect(paths).toEqual([]);
      expect(api.callsTo("files.download")).toHaveLength(0);
    });
  }

  test("the secondary menu stays deliberate and doesn't activate the primary target", async () => {
    const { paths } = setup();

    fireEvent.click(await screen.findByRole("button", { name: `Actions for ${DOCUMENT.name}` }));
    expect(await screen.findByRole("menuitem", { name: "Open in editor" })).toBeTruthy();
    expect(paths).toEqual([]);
  });

  test("the server disabling the editor still previews, download one action away", async () => {
    const { api, paths } = setup([]);
    const target = await documentTarget();

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    fireEvent.click(target);

    expect(paths).toEqual([]);
    expect(api.callsTo("files.download")).toHaveLength(0);
    expect(await screen.findByRole("heading", { name: DOCUMENT.name })).toBeTruthy();
    expect(await screen.findByText("file bytes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Download ${DOCUMENT.name}` }));
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(1));
  });

  test("an early click cannot download while server capabilities are unresolved", async () => {
    const available = deferred<{ apps: (typeof WORD)[] }>();
    const { api, paths } = setup();

    api.handlers["editors.available"] = () => available.promise;
    const target = await documentTarget();

    expect(target.getAttribute("aria-disabled") === "true").toBe(true);
    fireEvent.click(target);
    expect(paths).toEqual([]);
    expect(api.callsTo("files.download")).toHaveLength(0);

    available.resolve({ apps: [WORD] });
    await waitFor(() => expect(target.getAttribute("aria-disabled") === "true").toBe(false));
    fireEvent.click(target);
    expect(paths).toEqual(["/edit/doc_click_1"]);
  });

  test("unsupported files preview when an editor is available, download one action away", async () => {
    const { api, paths } = setup();

    const target = await screen.findByRole("button", { name: new RegExp(`^${OTHER.name}`) });

    await waitFor(() => expect(target.getAttribute("aria-disabled") === "true").toBe(false));
    fireEvent.click(target);

    expect(paths).toEqual([]);
    expect(api.callsTo("files.download")).toHaveLength(0);
    expect(await screen.findByRole("heading", { name: OTHER.name })).toBeTruthy();
    expect(await screen.findByText("file bytes")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `Download ${OTHER.name}` }));
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(1));
  });

  test("many primary targets share one availability request", async () => {
    const files = Array.from({ length: 40 }, (_, index) =>
      fileEntry({ id: `doc_many_${index}`, name: `Synthetic ${index}.docx` }),
    );

    const api = createFakeApi({
      "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
      "files.list": () => fileList(files),
      "editors.available": () => ({ apps: [WORD] }),
    });

    mount(<CloudScreen path="/" onNavigate={() => {}} />, api);

    await screen.findByText("Synthetic 0.docx");
    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    expect(api.callsTo("editors.open")).toHaveLength(0);
  });

  test("a public folder's document click keeps the link's authorization path", async () => {
    const folder = folderEntry({ id: "folder_click", name: "Synthetic shared folder" });
    const paths: string[] = [];

    const api = createFakeApi({
      "shares.resolve": () => ({
        share: {
          id: "share_click",
          itemId: folder.id,
          role: "editor",
          recipientId: null,
          recipient: null,
          public: true,
          expiresAt: null,
          passwordProtected: false,
          revokedAt: null,
          url: null,
        },
        item: folder,
        requiresPassword: false,
      }),
      "files.list": () => fileList([DOCUMENT], folder),
      "editors.available": () => ({ apps: [WORD] }),
    });

    mount(<CloudScreen path="/share/click_token" onNavigate={(path) => paths.push(path)} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open" }));
    const target = await documentTarget();

    await waitFor(() => expect(api.callsTo("editors.available")).toHaveLength(1));
    fireEvent.click(target);

    expect(paths).toEqual(["/share/click_token/edit/doc_click_1"]);
    expect(api.callsTo("auth.status")).toHaveLength(0);
    expect(api.callsTo("files.download")).toHaveLength(0);
  });
});
