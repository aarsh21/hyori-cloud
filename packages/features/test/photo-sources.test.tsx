import { describe, expect } from "bun:test";
import { PhotosSetup } from "#features/photos/react/photos-setup.tsx";
import {
  createFakeApi,
  fileList,
  fireEvent,
  folderEntry,
  mount,
  screen,
  test,
  VIEWER_ACCESS,
  waitFor,
} from "#features-test/mounted.tsx";
import type { RequestInput } from "#features-test/mounted.tsx";

const OWN = folderEntry({ id: "folder_own", name: "Pictures" });
const SHARED = folderEntry({ id: "folder_shared", name: "Trip", access: VIEWER_ACCESS });
const INSIDE = folderEntry({ id: "folder_inside", name: "Day one", access: VIEWER_ACCESS });

function listFolders({ view, parentId }: RequestInput) {
  if (parentId === SHARED.id) {
    return fileList([INSIDE], SHARED, [{ id: SHARED.id, name: SHARED.name }]);
  }

  return fileList(view === "shared" ? [SHARED] : [OWN]);
}

function sourcesApi() {
  return createFakeApi({
    "files.list": listFolders,
    "photos.setSources": ({ folderIds }) => ({ allMyFiles: false, folderIds: folderIds ?? [] }),
  });
}

function sharedTab() {
  return screen.findByRole("button", { name: "Shared with me" });
}

describe("choosing what appears in Photos", () => {
  test("folders shared with this person can be chosen, not only their own", async () => {
    const api = sourcesApi();

    mount(<PhotosSetup />, api);
    await screen.findByText("Pictures");
    expect(screen.getByText("Suggested")).toBeTruthy();

    fireEvent.click(await sharedTab());
    await screen.findByText("Trip");

    // A shared folder that happens to be called Pictures isn't the suggested one of your own.
    expect(screen.queryByText("Suggested")).toBeNull();
    expect(api.calls.at(-1)?.input).toMatchObject({ parentId: null, view: "shared" });

    fireEvent.click(screen.getByRole("checkbox"));
    fireEvent.click(screen.getByRole("button", { name: "Show my photos" }));

    await waitFor(() => expect(api.callsTo("photos.setSources")).toHaveLength(1));
    expect(api.callsTo("photos.setSources")[0]?.input).toEqual({
      allMyFiles: false,
      folderIds: [SHARED.id],
    });
  });

  test("inside a shared folder, going back returns to what's shared", async () => {
    const api = sourcesApi();

    mount(<PhotosSetup />, api);
    fireEvent.click(await sharedTab());
    fireEvent.click(await screen.findByRole("button", { name: "Open Trip" }));
    await screen.findByText("Day one");

    expect(api.calls.at(-1)?.input.view).toBeUndefined();

    fireEvent.click(screen.getByRole("button", { name: "Up one folder" }));
    await screen.findByRole("button", { name: "Open Trip" });
  });

  test("with all of their own files on, only shared folders are left to choose", async () => {
    mount(<PhotosSetup />, sourcesApi());
    await screen.findByText("Pictures");

    fireEvent.click(screen.getByRole("switch"));

    await screen.findByText("Also include folders shared with you");
    await screen.findByText("Trip");
    expect(screen.queryByText("Pictures")).toBeNull();
    expect(screen.queryByRole("button", { name: "My folders" })).toBeNull();
    expect(screen.getByText(/If sharing ends, those photos leave your timeline/)).toBeTruthy();
  });
});
