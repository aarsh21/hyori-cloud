import { describe, expect } from "bun:test";
import type { FileEntry } from "@hyori-cloud/client-sdk";
import { writeSingleKeyShortcuts } from "@hyori-cloud/ui/lib/single-key-shortcuts";
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
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";
import type { RequestInput } from "#features-test/mounted.tsx";

const FOLDER_A = folderEntry({ id: "folder_a", name: "Alpha" });
const FOLDER_B = folderEntry({ id: "folder_b", name: "Bravo" });
const ROADMAP = fileEntry({ id: "file_1", name: "roadmap.pdf", parentId: FOLDER_A.id });
const NOTES = fileEntry({ id: "file_2", name: "notes.txt", parentId: FOLDER_A.id });

function listFolder({ parentId, search }: RequestInput) {
  const folder = parentId === FOLDER_B.id ? FOLDER_B : FOLDER_A;
  const inside = folder === FOLDER_A ? [ROADMAP, NOTES] : [];
  const items = inside.filter((item) => item.name.includes(String(search ?? "")));

  return fileList(items, folder, [{ id: folder.id, name: folder.name }]);
}

function signedInApi() {
  return createFakeApi({
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
    "files.list": listFolder,
  });
}

function searchBox(name: RegExp = /Search this folder/) {
  return screen.getByRole<HTMLInputElement>("searchbox", { name });
}

function renderAt(path: string, api: ReturnType<typeof signedInApi>) {
  return mount(<CloudScreen path={path} onNavigate={() => {}} />, api);
}

describe("server-computed rename access", () => {
  test("successive row menus act on their own file and Escape restores the trigger", async () => {
    renderAt("/folders/folder_a", signedInApi());

    const first = await screen.findByRole("button", { name: "Actions for roadmap.pdf" });
    fireEvent.click(first);
    const menu = await screen.findByRole("menu");
    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(document.activeElement).toBe(first));

    const second = screen.getByRole("button", { name: "Actions for notes.txt" });
    fireEvent.click(second);
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));

    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" })).value).toBe(
      "notes.txt",
    );
  });

  test("a refetch removing the open menu's row closes it without affecting another row", async () => {
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for roadmap.pdf" }));
    await screen.findByRole("menu");

    api.handlers["files.list"] = () => fileList([NOTES], FOLDER_A, []);
    await view.refetchActive();
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Actions for roadmap.pdf" })).toBeNull();
      expect(screen.queryByRole("menu")).toBeNull();
    });

    fireEvent.click(screen.getByRole("button", { name: "Actions for notes.txt" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    expect((await screen.findByRole<HTMLInputElement>("textbox", { name: "Name" })).value).toBe(
      "notes.txt",
    );
  });

  for (const canRename of [false, true]) {
    test(`an Editor ${canRename ? "can" : "cannot"} rename through the menu and F2`, async () => {
      const entry = fileEntry({
        id: "shared_file",
        name: "shared.txt",
        access: {
          ...NOTES.access,
          isOwner: false,
          canEdit: true,
          canRename,
          canDelete: false,
          canShare: false,
        },
      });

      const api = signedInApi();
      api.handlers["files.list"] = () => fileList([entry], FOLDER_A, []);
      renderAt("/folders/folder_a", api);

      fireEvent.click(await screen.findByRole("button", { name: "Actions for shared.txt" }));
      await screen.findByRole("menu");
      expect(screen.queryByRole("menuitem", { name: /Rename/ }) !== null).toBe(canRename);
      expect(screen.getByRole("menuitem", { name: /Upload new version/ })).toBeTruthy();
      fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      fireEvent.keyDown(screen.getByRole("button", { name: /^shared\.txt/ }), { key: "F2" });

      if (canRename) await screen.findByRole("dialog");
      else expect(screen.queryByRole("dialog")).toBeNull();
    });
  }
});

describe("search field and the filter it describes", () => {
  test("returning to a folder shows the search that is still applied there", async () => {
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);

    await screen.findByText("roadmap.pdf");
    fireEvent.change(searchBox(), { target: { value: "road" } });
    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());

    view.rerender(<CloudScreen path="/folders/folder_b" onNavigate={() => {}} />);
    await waitFor(() => expect(searchBox().value).toBe(""));

    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);
    await waitFor(() => expect(searchBox().value).toBe("road"));
    expect(screen.getByText("roadmap.pdf")).toBeTruthy();
    expect(screen.queryByText("notes.txt")).toBeNull();
  });

  test("clearing filters also empties the search box", async () => {
    renderAt("/folders/folder_a", signedInApi());

    await screen.findByText("roadmap.pdf");
    fireEvent.change(searchBox(), { target: { value: "zzz" } });
    fireEvent.click(await screen.findByRole("button", { name: "Clear filters" }));

    await waitFor(() => expect(searchBox().value).toBe(""));
    expect(await screen.findByText("notes.txt")).toBeTruthy();
  });

  test("a space typed between words survives the commit of the word before it", async () => {
    renderAt("/folders/folder_a", signedInApi());

    await screen.findByText("roadmap.pdf");
    fireEvent.change(searchBox(), { target: { value: "road " } });
    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());

    expect(searchBox().value).toBe("road ");
  });

  test("the label says what a search covers at the root and inside a folder", async () => {
    const api = createFakeApi({
      "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
      "files.list": () => fileList([FOLDER_A]),
    });

    const view = renderAt("/", api);

    await screen.findByText("Alpha");
    expect(searchBox(/Search all files/)).toBeTruthy();

    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);
    await waitFor(() => expect(searchBox()).toBeTruthy());
  });
});

describe("continuity while the listing changes", () => {
  test("a filter change in a folder keeps its title, actions, and rows", async () => {
    const pending = deferred<object>();
    const api = signedInApi();

    renderAt("/folders/folder_a", api);
    await screen.findByText("roadmap.pdf");
    api.handlers["files.list"] = () => pending.promise;

    fireEvent.change(searchBox(), { target: { value: "road" } });
    await waitFor(() =>
      expect(api.callsTo("files.list").some((call) => call.input.search === "road")).toBe(true),
    );

    expect(screen.getByRole("button", { name: "Upload" })).toBeTruthy();
    expect(screen.getByText("notes.txt").closest('[aria-busy="true"]')).not.toBeNull();
    expect(screen.getAllByText("Alpha").length).toBeGreaterThan(0);

    pending.resolve(fileList([ROADMAP], FOLDER_A, [{ id: FOLDER_A.id, name: FOLDER_A.name }]));
    await waitFor(() => expect(screen.queryByText("notes.txt")).toBeNull());
  });

  test("entering another folder never shows the previous folder's rows", async () => {
    const pending = deferred<object>();
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);

    await screen.findByText("roadmap.pdf");
    api.handlers["files.list"] = () => pending.promise;

    view.rerender(<CloudScreen path="/folders/folder_b" onNavigate={() => {}} />);

    await waitFor(() => expect(screen.queryByText("roadmap.pdf")).toBeNull());
    pending.resolve(fileList([], FOLDER_B, [{ id: FOLDER_B.id, name: FOLDER_B.name }]));
    expect(await screen.findByText("This folder is empty")).toBeTruthy();
  });
});

describe("dialogs belong to the folder and target they opened on", () => {
  const PHOTO = fileEntry({
    id: "photo_1",
    name: "photo.png",
    parentId: FOLDER_A.id,
    mimeType: "image/png",
  });

  function folderApi(items: readonly FileEntry[]) {
    const api = signedInApi();

    api.handlers["files.list"] = ({ parentId }) =>
      parentId === FOLDER_B.id
        ? fileList([], FOLDER_B, [{ id: FOLDER_B.id, name: FOLDER_B.name }])
        : fileList(items, FOLDER_A, [{ id: FOLDER_A.id, name: FOLDER_A.name }]);

    api.handlers["files.preview"] = () => ({
      url: "/content/photo_1",
      name: PHOTO.name,
      size: 7,
      mimeType: PHOTO.mimeType,
    });

    return api;
  }

  test("a viewer left open doesn't reopen when returning to its folder", async () => {
    const view = renderAt("/folders/folder_a", folderApi([PHOTO]));

    fireEvent.click(await screen.findByRole("button", { name: /^photo\.png/ }));
    await screen.findByRole("dialog");

    view.rerender(<CloudScreen path="/folders/folder_b" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);
    await screen.findByRole("button", { name: /^photo\.png/, hidden: true });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("New folder closes on leaving, so it can't create in the wrong folder", async () => {
    const api = folderApi([ROADMAP]);
    const view = renderAt("/folders/folder_a", api);

    await screen.findByRole("button", { name: /^roadmap\.pdf/ });
    fireEvent.click(screen.getByRole("button", { name: "New folder" }));
    await screen.findByRole("dialog");

    view.rerender(<CloudScreen path="/folders/folder_b" onNavigate={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);
    await screen.findByRole("button", { name: /^roadmap\.pdf/, hidden: true });

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a dialog whose target left the list doesn't return with it", async () => {
    const api = folderApi([ROADMAP, NOTES]);
    const view = renderAt("/folders/folder_a", api);

    fireEvent.keyDown(await screen.findByRole("button", { name: /^notes\.txt/ }), { key: "F2" });
    await screen.findByRole("dialog");

    api.handlers["files.list"] = () => fileList([ROADMAP], FOLDER_A, []);
    await view.refetchActive();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    api.handlers["files.list"] = () => fileList([ROADMAP, NOTES], FOLDER_A, []);
    await view.refetchActive();
    await screen.findByRole("button", { name: /^notes\.txt/, hidden: true });

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("moving a file", () => {
  const DESTINATION = folderEntry({ id: "folder_c", name: "Charlie", parentId: FOLDER_A.id });
  const STILL_THERE = fileList([ROADMAP, NOTES], FOLDER_A, [{ id: FOLDER_A.id, name: "Alpha" }]);

  function moveApi() {
    const api = signedInApi();

    api.handlers["files.list"] = ({ type, parentId }) => {
      if (type === "folder") return fileList(parentId === FOLDER_A.id ? [DESTINATION] : []);

      return parentId === DESTINATION.id ? fileList([], DESTINATION) : STILL_THERE;
    };

    return api;
  }

  async function chooseDestination() {
    fireEvent.click(await screen.findByRole("button", { name: "Actions for notes.txt" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Charlie" }));
  }

  test("the dialog waits for every refresh, even when the row leaves first", async () => {
    const pickerAnswer = deferred<object>();
    const api = moveApi();
    const view = renderAt("/folders/folder_a", api);

    await chooseDestination();

    api.handlers["files.move"] = () => ({ ...NOTES, parentId: DESTINATION.id });

    api.handlers["files.list"] = ({ type }) =>
      type === "folder" ? pickerAnswer.promise : fileList([ROADMAP], FOLDER_A, []);

    fireEvent.click(await screen.findByRole("button", { name: "Move here" }));

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /^notes\.txt/, hidden: true })).toBeNull(),
    );

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(/Move “notes\.txt”/)).toBeTruthy();
    expect(screen.getByText("Moving…").closest("button")?.getAttribute("aria-busy")).toBe("true");

    pickerAnswer.resolve(fileList([]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    view.rerender(<CloudScreen path="/folders/folder_c" onNavigate={() => {}} />);
    await waitFor(() => expect(api.callsTo("files.list").at(-1)?.input.parentId).toBe("folder_c"));

    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("a failed move is gone, and the picker back at the start, after reopening", async () => {
    const api = moveApi();

    api.handlers["files.move"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);

    await chooseDestination();
    fireEvent.click(await screen.findByRole("button", { name: "Move here" }));
    await screen.findByText("Hyori can’t reach its services");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await reopenMoveDialog();

    expect(screen.queryByText("Hyori can’t reach its services")).toBeNull();
    expect(await screen.findByRole("button", { name: "Charlie" })).toBeTruthy();
  });

  async function reopenMoveDialog() {
    fireEvent.click(await screen.findByRole("button", { name: "Actions for notes.txt" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: "Move…" }));
    await screen.findByRole("dialog");
  }
});

describe("row actions", () => {
  const REMOVED = { ...NOTES, trashedAt: "2026-11-04T00:00:00Z" };

  for (const outcome of ["success", "failure"] as const) {
    test(`an earlier trash ${outcome} keeps its own feedback while another row is pending`, async () => {
      const first = Promise.withResolvers<object>();
      const second = Promise.withResolvers<object>();
      const api = signedInApi();
      api.handlers["files.trash"] = ({ id }) =>
        id === ROADMAP.id ? first.promise : second.promise;
      renderAt("/folders/folder_a", api);
      const firstRow = await screen.findByRole("button", { name: /^roadmap\.pdf/ });
      const secondRow = screen.getByRole("button", { name: /^notes\.txt/ });
      fireEvent.keyDown(firstRow, { key: "Delete" });
      fireEvent.keyDown(secondRow, { key: "Delete" });
      await waitFor(() => expect(api.callsTo("files.trash")).toHaveLength(2));

      if (outcome === "success") {
        first.resolve({ ...ROADMAP, trashedAt: "2026-11-04T00:00:00Z" });
        expect(await screen.findByText("Moved “roadmap.pdf” to Trash")).toBeTruthy();
        expect(screen.getByRole("button", { name: "Undo" })).toBeTruthy();
      } else {
        first.reject(new ApiFailure("service.unavailable"));
        expect(await screen.findByText("Hyori can’t reach its services")).toBeTruthy();
      }

      second.resolve(REMOVED);
      expect(await screen.findByText("Moved “notes.txt” to Trash")).toBeTruthy();
    });
  }

  test("an earlier download failure stays visible after a second download starts", async () => {
    const first = Promise.withResolvers<object>();
    const second = Promise.withResolvers<object>();
    const api = signedInApi();
    api.handlers["files.download"] = ({ id }) =>
      id === ROADMAP.id ? first.promise : second.promise;
    renderAt("/folders/folder_a", api);
    fireEvent.click(await screen.findByRole("button", { name: /^roadmap\.pdf/ }));
    fireEvent.click(screen.getByRole("button", { name: /^notes\.txt/ }));
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(2));
    first.reject(new ApiFailure("service.unavailable"));
    expect(await screen.findByText("Hyori can’t reach its services")).toBeTruthy();
    second.resolve({ url: "#", name: NOTES.name, size: 7, mimeType: NOTES.mimeType });
  });

  test("double-clicking a document sends one request and shows progress on the row", async () => {
    const answer = deferred<object>();
    const api = signedInApi();

    api.handlers["files.download"] = () => answer.promise;
    renderAt("/folders/folder_a", api);

    const row = await screen.findByRole("button", { name: /^notes\.txt/ });

    fireEvent.click(row);
    fireEvent.click(row);

    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(1));
    expect(await screen.findByRole("status", { name: "Working on notes.txt" })).toBeTruthy();
    expect(row.closest('[aria-busy="true"]')).not.toBeNull();

    answer.resolve({ url: "#", name: NOTES.name, size: 7, mimeType: NOTES.mimeType });
    await waitFor(() => expect(row.closest('[aria-busy="true"]')).toBeNull());
    expect(api.callsTo("files.download")).toHaveLength(1);
  });

  test("repeated Delete presses trash once and report only success", async () => {
    const api = signedInApi();

    api.handlers["files.trash"] = () => REMOVED;
    renderAt("/folders/folder_a", api);

    const row = await screen.findByRole("button", { name: /^notes\.txt/ });

    fireEvent.keyDown(row, { key: "Delete" });
    fireEvent.keyDown(row, { key: "Delete" });
    fireEvent.keyDown(row, { key: "Delete", repeat: true });

    expect(await screen.findByText("Moved “notes.txt” to Trash")).toBeTruthy();
    expect(api.callsTo("files.trash")).toHaveLength(1);
  });

  test("removing the focused row moves focus to the row that replaced it", async () => {
    const api = signedInApi();

    api.handlers["files.trash"] = () => {
      api.handlers["files.list"] = () => fileList([NOTES], FOLDER_A, []);

      return { ...ROADMAP, trashedAt: "2026-11-04T00:00:00Z" };
    };

    renderAt("/folders/folder_a", api);

    const row = await screen.findByRole("button", { name: /^roadmap\.pdf/ });

    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Delete" });

    await waitFor(() => expect(screen.queryByText("roadmap.pdf")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: /^notes\.txt/ })),
    );
  });

  test("focus somewhere else stays put when a row is removed", async () => {
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);
    const row = await screen.findByRole("button", { name: /^roadmap\.pdf/ });

    act(() => row.focus());

    const search = searchBox();

    act(() => search.focus());
    api.handlers["files.list"] = () => fileList([NOTES], FOLDER_A, []);
    await view.refetchActive();
    await waitFor(() => expect(screen.queryByText("roadmap.pdf")).toBeNull());

    expect(document.activeElement).toBe(search);
  });
});

describe("file action failure ownership", () => {
  test("dismissing one failure reveals the next without acknowledging it", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = ({ id }) => {
      throw new ApiFailure(id === ROADMAP.id ? "service.unavailable" : "auth.required");
    };

    renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^roadmap\.pdf/ }), {
      key: "Delete",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /^notes\.txt/ }), { key: "Delete" });
    await screen.findByText("Hyori can’t reach its services");
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Working on notes.txt" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(await screen.findByText("Your session has ended")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeTruthy();
  });

  test("one dismissal acknowledges identical failures without repeating the same notice", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^roadmap\.pdf/ }), {
      key: "Delete",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /^notes\.txt/ }), { key: "Delete" });
    await screen.findByText("Hyori can’t reach its services");
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Working on notes.txt" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Hyori can’t reach its services")).toBeNull());
  });

  test("identical visible service feedback is grouped even when internal messages differ", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = ({ id }) => {
      throw new ApiFailure(
        "service.unavailable",
        id === ROADMAP.id ? "Database unavailable" : "Storage unavailable",
      );
    };

    renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^roadmap\.pdf/ }), {
      key: "Delete",
    });
    fireEvent.keyDown(screen.getByRole("button", { name: /^notes\.txt/ }), { key: "Delete" });
    await screen.findByText("Hyori can’t reach its services");
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Working on notes.txt" })).toBeNull(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByText("Hyori can’t reach its services")).toBeNull());
  });

  test("a failed Undo still reports from its toast after leaving Files", async () => {
    const api = signedInApi();
    const removed = { ...NOTES, trashedAt: "2026-11-04T00:00:00Z" };
    api.handlers["files.trash"] = () => removed;
    api.handlers["files.restore"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    api.handlers["files.list"] = (input) =>
      input.view === "trash" ? fileList([removed]) : listFolder(input);
    const view = renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^notes\.txt/ }), {
      key: "Delete",
    });
    await screen.findByText("Moved “notes.txt” to Trash");
    view.rerender(<CloudScreen path="/trash" onNavigate={() => {}} />);
    await screen.findByRole("button", { name: "Restore" });
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(await screen.findByText("Couldn’t restore “notes.txt”")).toBeTruthy();
  });

  test("a failed Undo reports once, from its toast, and retries there", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = () => ({ ...NOTES, trashedAt: "2026-11-04T00:00:00Z" });
    api.handlers["files.restore"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^notes\.txt/ }), {
      key: "Delete",
    });
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await screen.findByText("Couldn’t restore “notes.txt”");
    expect(screen.getAllByText("Hyori can’t reach its services")).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Dismiss" })).toBeNull();
    api.handlers["files.restore"] = () => NOTES;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(api.callsTo("files.restore")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText("Couldn’t restore “notes.txt”")).toBeNull());
  });

  test("a failed delete on the page reports once, in its notice", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^notes\.txt/ }), {
      key: "Delete",
    });
    await screen.findByRole("button", { name: "Dismiss" });
    await waitFor(() => expect(api.callsTo("files.trash")).toHaveLength(1));
    expect(screen.getAllByText("Hyori can’t reach its services")).toHaveLength(1);
    expect(screen.queryByText("Couldn’t move “notes.txt” to Trash")).toBeNull();
  });

  test("retrying a failed download clears only that download's older failure", async () => {
    const api = signedInApi();
    api.handlers["files.download"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);
    const row = await screen.findByRole("button", { name: /^notes\.txt/ });
    fireEvent.click(row);
    await screen.findByText("Hyori can’t reach its services");
    api.handlers["files.download"] = () => ({
      url: "#",
      name: NOTES.name,
      size: NOTES.size,
      mimeType: NOTES.mimeType,
    });
    fireEvent.click(row);
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(2));
    expect(screen.queryByText("Hyori can’t reach its services")).toBeNull();
  });

  test("a delete that fails after leaving Files reports its own filename", async () => {
    const answer = Promise.withResolvers<object>();
    const api = signedInApi();
    api.handlers["files.trash"] = () => answer.promise;
    api.handlers["files.list"] = (input) =>
      input.view === "trash" ? fileList([]) : listFolder(input);
    const view = renderAt("/folders/folder_a", api);
    fireEvent.keyDown(await screen.findByRole("button", { name: /^notes\.txt/ }), {
      key: "Delete",
    });
    await waitFor(() => expect(api.callsTo("files.trash")).toHaveLength(1));
    view.rerender(<CloudScreen path="/trash" onNavigate={() => {}} />);
    await screen.findByText("Trash is empty");
    answer.reject(new ApiFailure("service.unavailable"));
    expect(await screen.findByText("Couldn’t move “notes.txt” to Trash")).toBeTruthy();
  });

  test("retrying an item clears its old failure after success", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    renderAt("/folders/folder_a", api);
    const row = await screen.findByRole("button", { name: /^notes\.txt/ });
    fireEvent.keyDown(row, { key: "Delete" });
    await screen.findByText("Hyori can’t reach its services");
    api.handlers["files.trash"] = () => ({ ...NOTES, trashedAt: "2026-11-04T00:00:00Z" });
    fireEvent.keyDown(row, { key: "Delete" });
    await screen.findByText("Moved “notes.txt” to Trash");
    expect(screen.queryByText("Hyori can’t reach its services")).toBeNull();
  });

  test("retrying one item preserves an earlier failure on another item", async () => {
    const api = signedInApi();
    api.handlers["files.trash"] = ({ id }) => {
      throw new ApiFailure(id === ROADMAP.id ? "access.denied" : "resource.conflict");
    };

    renderAt("/folders/folder_a", api);
    const first = await screen.findByRole("button", { name: /^roadmap\.pdf/ });
    fireEvent.keyDown(first, { key: "Delete" });
    fireEvent.keyDown(screen.getByRole("button", { name: /^notes\.txt/ }), { key: "Delete" });
    await screen.findByText("You don’t have access to this");
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Working on notes.txt" })).toBeNull(),
    );
    api.handlers["files.trash"] = () => ({ ...ROADMAP, trashedAt: "2026-11-04T00:00:00Z" });
    fireEvent.keyDown(first, { key: "Delete" });
    await screen.findByText("Moved “roadmap.pdf” to Trash");
    expect(screen.getByText("That couldn’t be applied")).toBeTruthy();
    expect(screen.queryByText("You don’t have access to this")).toBeNull();
  });

  test("a Trash restore failure does not leak into Files", async () => {
    const api = signedInApi();
    api.handlers["files.list"] = (input) =>
      input.view === "trash"
        ? fileList([{ ...NOTES, trashedAt: "2026-11-04T00:00:00Z" }])
        : listFolder(input);
    api.handlers["files.restore"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    const view = renderAt("/trash", api);
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));
    await screen.findByText("Hyori can’t reach its services");
    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);
    await screen.findByRole("button", { name: /^roadmap\.pdf/ });
    expect(screen.queryByText("Hyori can’t reach its services")).toBeNull();
  });

  test("viewer download failures remain local and leave no page notice after closing", async () => {
    const photo = fileEntry({
      id: "photo_1",
      name: "photo.png",
      parentId: FOLDER_A.id,
      mimeType: "image/png",
    });

    const api = signedInApi();
    api.handlers["files.list"] = () => fileList([photo], FOLDER_A, []);
    api.handlers["files.preview"] = () => ({
      url: "/content/photo_1",
      name: photo.name,
      size: photo.size,
      mimeType: photo.mimeType,
    });
    renderAt("/folders/folder_a", api);
    fireEvent.click(await screen.findByRole("button", { name: /^photo\.png/ }));
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    api.handlers["files.download"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(screen.getByRole("button", { name: "Download photo.png" }));
    await screen.findByText(/Couldn’t download/);
    expect(screen.getAllByRole("alert")).toHaveLength(1);
    expect(screen.queryByText("Hyori can’t reach its services")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close viewer" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("single-key shortcuts", () => {
  test("work until turned off, and their hint goes with them", async () => {
    renderAt("/folders/folder_a", signedInApi());
    await screen.findByText("roadmap.pdf");
    expect(searchBox().getAttribute("aria-keyshortcuts")).toBe("/");

    fireEvent.keyDown(document.body, { key: "n" });
    expect(await screen.findByRole("dialog", { name: "New folder" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    act(() => writeSingleKeyShortcuts(false));

    await waitFor(() => expect(searchBox().getAttribute("aria-keyshortcuts")).toBeNull());
    fireEvent.keyDown(document.body, { key: "n" });
    expect(screen.queryByRole("dialog")).toBeNull();

    act(() => writeSingleKeyShortcuts(true));
  });
});

describe("filter visibility", () => {
  test("an active bar filter stays announced after the bar is closed", async () => {
    renderAt("/folders/folder_a", signedInApi());
    await screen.findByText("roadmap.pdf");

    const toggle = screen.getByRole("button", { name: "Filters" });

    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("combobox", { name: "File type" }));

    // Base UI commits a mouse selection only for a press that started on the option.
    const images = await screen.findByRole("option", { name: "Images" });

    fireEvent.pointerDown(images, { pointerType: "mouse" });
    fireEvent.click(images);

    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Filters, 1 active" })).toBeTruthy(),
    );

    fireEvent.click(screen.getByRole("button", { name: "Filters, 1 active" }));

    expect(screen.queryByRole("combobox", { name: "File type" })).toBeNull();
    expect(screen.getByRole("button", { name: "Filters, 1 active" })).toBeTruthy();
  });
});

describe("a session that ended", () => {
  test("with data on screen, offers sign-in that actually reaches the login screen", async () => {
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);

    await screen.findByText("roadmap.pdf");

    api.handlers["files.list"] = () => {
      throw new ApiFailure("auth.required");
    };

    await view.refetchActive();

    const signIn = await screen.findByRole("button", { name: "Sign in" });

    expect(screen.getByText("roadmap.pdf")).toBeTruthy();
    api.handlers["auth.status"] = () => ({ initialized: true, user: null });
    fireEvent.click(signIn);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });

  test("with no data, the blocking state recovers the same way", async () => {
    const api = signedInApi();

    api.handlers["files.list"] = () => {
      throw new ApiFailure("auth.required");
    };

    renderAt("/folders/folder_a", api);

    const signIn = await screen.findByRole("button", { name: "Sign in" });

    api.handlers["auth.status"] = () => ({ initialized: true, user: null });
    fireEvent.click(signIn);

    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeTruthy();
  });
});

describe("the list or grid choice", () => {
  test("survives leaving the screen and coming back", async () => {
    const api = signedInApi();
    const view = renderAt("/folders/folder_a", api);

    fireEvent.click(await screen.findByRole("button", { name: "Grid" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Grid" }).getAttribute("aria-pressed")).toBe(
        "true",
      ),
    );

    api.handlers["files.list"] = () => fileList([]);
    view.rerender(<CloudScreen path="/trash" onNavigate={() => {}} />);
    await screen.findByText("Trash is empty");
    api.handlers["files.list"] = listFolder;
    view.rerender(<CloudScreen path="/folders/folder_a" onNavigate={() => {}} />);

    const grid = await screen.findByRole("button", { name: "Grid" });

    expect(grid.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("Trash and the keyboard", () => {
  test("restoring moves focus to the row that takes its place", async () => {
    const trashed = fileEntry({
      id: "file_t1",
      name: "old.txt",
      trashedAt: "2026-11-04T00:00:00Z",
    });

    const other = fileEntry({
      id: "file_t2",
      name: "older.txt",
      trashedAt: "2026-11-03T00:00:00Z",
    });

    let items = [trashed, other];

    const api = createFakeApi({
      "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
      "files.list": () => fileList(items),
      "files.restore": () => {
        items = [other];

        return trashed;
      },
    });

    renderAt("/trash", api);

    const [first] = await screen.findAllByRole("button", { name: "Restore" });

    if (first === undefined) throw new Error("Trash has no rows.");
    act(() => first.focus());
    fireEvent.click(first);

    await waitFor(() => expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1));
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Restore" })),
    );
  });

  test("a tap elsewhere in the row can't restore", async () => {
    const trashed = fileEntry({
      id: "file_t1",
      name: "old.txt",
      trashedAt: "2026-11-04T00:00:00Z",
    });

    const api = createFakeApi({
      "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
      "files.list": () => fileList([trashed]),
    });

    renderAt("/trash", api);

    const restore = await screen.findByRole("button", { name: "Restore" });

    expect(restore.className).toContain("after:hidden!");
  });
});

describe("what the server's errors mean to people", () => {
  test("a name clash reads as a sentence, not the server's message", async () => {
    const api = signedInApi();

    api.handlers["files.rename"] = () => {
      throw new ApiFailure("resource.conflict", "Resource conflicts with existing state");
    };

    renderAt("/folders/folder_a", api);
    fireEvent.click(await screen.findByRole("button", { name: "Actions for roadmap.pdf" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Rename/ }));
    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "notes.txt" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));

    await screen.findByText("That couldn’t be applied");
    expect(screen.queryByText(/Resource conflicts/)).toBeNull();
  });
});
