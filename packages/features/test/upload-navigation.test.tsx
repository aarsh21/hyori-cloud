import { describe, expect } from "bun:test";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
import {
  createFakeApi,
  deferred,
  fileEntry,
  fileList,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

/**
 * Opening a document leaves the file manager for the editor's own screen. The account's upload
 * queue must outlive that switch, or every transfer still in flight is lost on the way.
 */

const REPORT = fileEntry({ id: "file_1", name: "report.docx", size: 7 });
const WORD = { app: "wordcraft", version: "0.14.0", inputExtensions: [".docx"] };

const UPLOADING = {
  uploadId: "upload_1",
  chunkSize: 1024,
  totalParts: 1,
  parts: [],
  state: "uploading",
  fileId: null,
};

const DOCUMENT = {
  sessionId: "session_1",
  app: "wordcraft",
  bridge: "upstream-host-parent",
  protocol: null,
  version: "0.14.0",
  name: REPORT.name,
  revision: "3",
  writable: true,
  maxBytes: 1024 * 1024,
  replacementName: REPORT.name,
  outputFormats: [{ extension: ".docx", kind: "document" }],
  assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
};

function setup() {
  const api = createFakeApi({
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
    "files.list": () => fileList([REPORT]),
    "files.get": () => REPORT,
    "editors.available": () => ({ apps: [WORD] }),
    "editors.open": () => DOCUMENT,
    "editors.download": () => ({
      url: "/synthetic-bytes",
      name: REPORT.name,
      size: REPORT.size,
      mimeType: "application/octet-stream",
    }),
    "uploads.begin": () => UPLOADING,
    "uploads.status": () => UPLOADING,
    "uploads.part": () => ({ url: "/parts/1", method: "PUT", headers: {} }),
    "uploads.complete": () => REPORT,
  });

  const release = deferred<void>();
  const puts: string[] = [];

  const view = mount(<CloudScreen path="/" onNavigate={() => {}} />, {
    ...api,
    fetch: async (url, init) => {
      if (init?.method !== "PUT") return api.fetch(url, init);
      puts.push(String(url));
      await release.promise;

      return new Response(null, { status: 200 });
    },
  });

  return {
    api,
    puts,
    release,
    navigate: (path: string) => view.rerender(<CloudScreen path={path} onNavigate={() => {}} />),
  };
}

async function startNewVersion() {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${REPORT.name}` }));
  fireEvent.click(await screen.findByRole("menuitem", { name: "Upload new version…" }));

  const input = await waitFor(() => {
    const dialog = screen.getByRole("dialog");
    const input = dialog.querySelector<HTMLInputElement>('input[type="file"]');

    if (input === null) throw new Error("The dialog has no file input.");

    return input;
  });

  fireEvent.change(input, { target: { files: [new File(["new contents"], REPORT.name)] } });
  fireEvent.click(await screen.findByRole("button", { name: "Upload new version" }));
}

describe("uploads across the editor", () => {
  test("a running upload keeps going while a document is open, and finishes after returning", async () => {
    const { api, puts, release, navigate } = setup();

    await startNewVersion();
    await waitFor(() => expect(puts).toHaveLength(1));

    navigate("/edit/file_1");
    await waitFor(() => expect(api.callsTo("editors.open")).toHaveLength(1));

    // Still in progress, and still visible from the editor.
    const tray = await screen.findByRole("region", { name: "Uploads" });

    expect(tray.textContent).toContain("Uploading 1 file");

    navigate("/");
    await screen.findByRole("button", { name: `Actions for ${REPORT.name}` });
    release.resolve();

    await screen.findByLabelText("Uploaded");
    expect(screen.queryByText(/Interrupted/)).toBeNull();
    expect(api.callsTo("uploads.begin")).toHaveLength(1);
    expect(api.callsTo("uploads.complete")).toHaveLength(1);
    expect(puts).toHaveLength(1);
  });
});
