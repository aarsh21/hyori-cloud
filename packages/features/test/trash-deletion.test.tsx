import { describe, expect } from "bun:test";
import { useAuthStatus } from "#features/auth/react/use-auth-status.ts";
import { TrashScreen } from "#features/files/react/trash-screen.tsx";
import { VersionHistoryDialog } from "#features/files/react/version-history-dialog.tsx";
import {
  ApiFailure,
  createFakeApi,
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

const TRASHED = "2026-11-04T00:00:00Z";
const REPORT = fileEntry({ id: "file_1", name: "report.pdf", size: 12, trashedAt: TRASHED });
const ALBUM = folderEntry({ id: "folder_1", name: "Holiday", trashedAt: TRASHED });

/** Stands in for the quota indicator: an observer of `auth.status`, which these mutations refresh. */
function QuotaObserver() {
  const status = useAuthStatus();

  return <p>{status.data?.user?.usedBytes ?? "…"} bytes used</p>;
}

function trashApi() {
  let trash = [REPORT, ALBUM];
  let used = 64;

  const api = createFakeApi({
    "auth.status": () => ({ initialized: true, user: { ...SIGNED_IN_USER, usedBytes: used } }),
    "files.list": () => fileList(trash),
    "files.trashSummary": () => ({ items: trash.length, freedBytes: 12 }),
    "files.emptyTrash": () => {
      const items = trash.length;
      trash = [];
      used -= 12;

      return { items, freedBytes: 12 };
    },
    "files.deletePermanently": ({ id }) => {
      trash = trash.filter((entry) => entry.id !== id);
      used -= 12;

      return { items: 1, freedBytes: 12 };
    },
  });

  return api;
}

function mountTrash() {
  const api = trashApi();
  mount(
    <>
      <QuotaObserver />
      <TrashScreen />
    </>,
    api,
  );

  return api;
}

describe("emptying Trash", () => {
  test("confirms with what it frees, then refreshes Trash and storage use", async () => {
    const api = mountTrash();

    await screen.findByText("report.pdf");
    await screen.findByText("64 bytes used");
    fireEvent.click(screen.getByRole("button", { name: "Empty Trash…" }));
    await screen.findByText("2 items · frees 12 B");
    expect(api.callsTo("files.emptyTrash")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Empty Trash" }));

    await screen.findByText("Emptied Trash");
    await screen.findByText("Freed 12 B");
    await screen.findByText("Trash is empty");
    await screen.findByText("52 bytes used");
    expect(screen.queryByRole("button", { name: "Empty Trash…" })).toBeNull();
  });

  test("cancelling deletes nothing, and a failure stays in the dialog", async () => {
    const api = mountTrash();

    api.handlers["files.emptyTrash"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(await screen.findByRole("button", { name: "Empty Trash…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Empty Trash" }));
    await screen.findByText("Hyori can’t reach its services");
    expect(screen.getByText("report.pdf")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull());
    expect(api.callsTo("files.emptyTrash")).toHaveLength(1);
  });
});

describe("deleting one item permanently", () => {
  test("names the item, explains a folder takes its contents, and removes only it", async () => {
    const api = mountTrash();

    fireEvent.click(await screen.findByRole("button", { name: "More actions for Holiday" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Delete permanently…" }));
    await screen.findByText("Permanently delete “Holiday”?");
    screen.getByText(/The folder and everything in it are deleted now/);

    fireEvent.click(screen.getByRole("button", { name: "Delete permanently" }));

    await screen.findByText("Permanently deleted “Holiday”");
    await waitFor(() => expect(screen.queryByText("Holiday")).toBeNull());
    expect(screen.getByText("report.pdf")).toBeTruthy();
    expect(api.callsTo("files.deletePermanently")).toEqual([
      { operation: "files.deletePermanently", input: { id: ALBUM.id } },
    ]);
    await screen.findByText("52 bytes used");
  });
});

describe("deleting an earlier version", () => {
  test("asks first, then removes that version from the history", async () => {
    const FILE = fileEntry({ id: "file_2", name: "notes.txt" });

    let versions = [
      { id: "v1", fileId: FILE.id, size: 5, createdAt: "2026-11-01T00:00:00Z" },
      { id: "v2", fileId: FILE.id, size: 9, createdAt: "2026-11-02T00:00:00Z" },
    ];

    const api = createFakeApi({
      "files.versions": () => ({ items: versions, nextCursor: null }),
      "files.deleteVersion": ({ versionId }) => {
        versions = versions.filter((version) => version.id !== versionId);

        return { items: 1, freedBytes: 5 };
      },
    });

    mount(<VersionHistoryDialog entry={FILE} open onOpenChange={() => undefined} />, api);

    const [first] = await screen.findAllByRole("button", { name: /^Delete version from/ });
    fireEvent.click(first!);
    await screen.findByText(/^Delete the version from/);
    fireEvent.click(screen.getByRole("button", { name: "Delete version" }));

    await screen.findByText("Freed 5 B");
    await waitFor(() =>
      expect(screen.getAllByRole("button", { name: /^Delete version from/ })).toHaveLength(1),
    );
    expect(api.callsTo("files.deleteVersion")).toEqual([
      { operation: "files.deleteVersion", input: { id: FILE.id, versionId: "v1" } },
    ]);
  });
});
