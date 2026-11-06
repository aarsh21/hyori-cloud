import { describe, expect } from "bun:test";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
import {
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

const SHARED_FOLDER = folderEntry({ id: "folder_s", name: "Trip", access: VIEWER_ACCESS });

const INSIDE = fileEntry({
  id: "file_s",
  name: "map.png",
  parentId: "folder_s",
  access: VIEWER_ACCESS,
});

const SHARE = {
  id: "share_1",
  itemId: SHARED_FOLDER.id,
  role: "viewer",
  recipientId: null,
  public: true,
  expiresAt: null,
  passwordProtected: false,
  revokedAt: null,
  url: null,
} as const;

const OPENED = { share: SHARE, item: SHARED_FOLDER, requiresPassword: false };
const LOCKED = { share: { ...SHARE, passwordProtected: true }, item: null, requiresPassword: true };

function listing() {
  return fileList([INSIDE], SHARED_FOLDER, [{ id: SHARED_FOLDER.id, name: SHARED_FOLDER.name }]);
}

function publicApi() {
  return createFakeApi({ "shares.resolve": () => OPENED, "files.list": listing });
}

async function openLinkIn(api: ReturnType<typeof publicApi>) {
  const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);

  fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
  await screen.findByText("map.png");

  return view;
}

function failListingWith(
  api: ReturnType<typeof publicApi>,
  code: "auth.required" | "access.denied",
) {
  api.handlers["files.list"] = () => {
    throw new ApiFailure(code, "Denied");
  };
}

test("changing the public-link token resets the previous link's open state", async () => {
  const api = createFakeApi({
    "shares.resolve": () => ({
      share: { ...SHARE, itemId: INSIDE.id },
      item: INSIDE,
      requiresPassword: false,
    }),
  });

  const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
  fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
  await screen.findByRole("heading", { name: INSIDE.name });
  view.rerender(<CloudScreen path="/share/token_2" onNavigate={() => {}} />);

  expect(screen.queryByRole("heading", { name: INSIDE.name }) === null).toBe(true);
  expect(screen.getByRole("button", { name: "Open shared item" })).toBeTruthy();
  expect(api.callsTo("shares.resolve")).toHaveLength(1);
});

describe("a public link whose grant stopped working", () => {
  for (const code of ["auth.required", "access.denied"] as const) {
    test(`${code} offers to open the link again, never to sign in`, async () => {
      const api = publicApi();
      const view = await openLinkIn(api);

      failListingWith(api, code);
      await view.refetchActive();

      const reopen = await screen.findByRole("button", { name: "Open link again" });

      expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
      expect(screen.getByText("map.png")).toBeTruthy();

      api.handlers["files.list"] = listing;
      fireEvent.click(reopen);

      await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(2));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull(),
      );
      expect(screen.getByText("map.png")).toBeTruthy();
    });
  }

  test("keeps the open folder on screen while the link is being reopened", async () => {
    const api = publicApi();
    const view = await openLinkIn(api);
    const answer = deferred<object>();

    failListingWith(api, "auth.required");
    await view.refetchActive();
    api.handlers["shares.resolve"] = () => answer.promise;
    api.handlers["files.list"] = listing;

    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));

    await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(2));
    expect(screen.getByText("map.png")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Open shared item" })).toBeNull();

    answer.resolve(OPENED);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull(),
    );
  });

  test("with nothing cached, the blocking failure recovers too", async () => {
    const api = publicApi();

    failListingWith(api, "auth.required");
    mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));

    const reopen = await screen.findByRole("button", { name: "Open link again" });

    expect(screen.queryByRole("button", { name: "Sign in" })).toBeNull();
    api.handlers["files.list"] = listing;
    fireEvent.click(reopen);

    expect(await screen.findByText("map.png")).toBeTruthy();
  });

  test("a revoked link says so and can be tried again", async () => {
    const api = publicApi();
    const view = await openLinkIn(api);

    failListingWith(api, "access.denied");
    await view.refetchActive();

    api.handlers["shares.resolve"] = () => {
      throw new ApiFailure("access.denied", "Shared link is unavailable");
    };

    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));

    const retry = await screen.findByRole("button", { name: "Try again" });

    expect(screen.getByText(/This link is no longer available/)).toBeTruthy();
    api.handlers["shares.resolve"] = () => OPENED;
    api.handlers["files.list"] = listing;
    fireEvent.click(retry);

    await waitFor(() => expect(screen.queryByRole("button", { name: "Try again" })).toBeNull());
    expect(screen.getByText("map.png")).toBeTruthy();
  });

  test("a password link asks for its password again, then returns to the item", async () => {
    const api = publicApi();

    api.handlers["shares.resolve"] = () => LOCKED;
    api.handlers["shares.unlock"] = () => OPENED;
    const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);

    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "hunter22!" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("map.png");

    failListingWith(api, "auth.required");
    await view.refetchActive();
    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));

    const password = await screen.findByLabelText("Password");

    api.handlers["files.list"] = listing;
    fireEvent.change(password, { target: { value: "hunter22!" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    expect(await screen.findByText("map.png")).toBeTruthy();
    expect(api.callsTo("shares.unlock")).toHaveLength(2);
  });

  test("a repeated reopen retains a password link's item and filters while pending and after failure", async () => {
    const api = publicApi();
    api.handlers["shares.resolve"] = () => LOCKED;
    api.handlers["shares.unlock"] = () => OPENED;
    const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    fireEvent.change(await screen.findByLabelText("Password"), { target: { value: "hunter22!" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));
    await screen.findByText("map.png");
    failListingWith(api, "access.denied");
    await view.refetchActive();
    api.handlers["shares.resolve"] = () => OPENED;
    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));
    await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(2));
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Open link again" }).getAttribute("aria-busy"),
      ).not.toBe("true"),
    );
    const search = screen.getByRole<HTMLInputElement>("searchbox", { name: /Search this folder/ });
    fireEvent.change(search, { target: { value: "map" } });
    const answer = Promise.withResolvers<object>();
    api.handlers["shares.resolve"] = () => answer.promise;
    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));
    await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(3));
    expect(screen.getByText("map.png")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("searchbox", { name: /Search this folder/ })).toBe(search);
    expect(search.value).toBe("map");
    answer.reject(new ApiFailure("service.unavailable"));
    await screen.findByRole("button", { name: "Try again" });
    expect(screen.getByText("map.png")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
    expect(screen.getByRole("searchbox", { name: /Search this folder/ })).toBe(search);
  });

  test("a failed upload survives the password prompt, then retries as the same task", async () => {
    const uploadable = { ...VIEWER_ACCESS, role: "contributor", canUpload: true } as const;
    const folder = { ...SHARED_FOLDER, access: uploadable };
    const crumbs = [{ id: folder.id, name: folder.name }];
    const api = publicApi();

    api.handlers["shares.resolve"] = () => ({ ...OPENED, item: folder });
    api.handlers["files.list"] = () => fileList([INSIDE], folder, crumbs);

    api.handlers["uploads.begin"] = () => {
      throw new ApiFailure("auth.required");
    };

    const { container } = await openLinkIn(api);
    const picker = container.querySelector('input[type="file"]');

    if (picker === null) throw new Error("The folder rendered no file picker.");

    fireEvent.change(picker, {
      target: { files: [new File(["bytes"], "held.bin", { type: "text/plain" })] },
    });

    const reopen = await screen.findByRole("button", { name: "Open link again" });

    // The grant is gone and this link has a password, so reopening stops at the prompt.
    const stillUploading = deferred<object>();

    api.handlers["shares.resolve"] = () => LOCKED;
    api.handlers["shares.unlock"] = () => ({ ...OPENED, item: folder });
    api.handlers["uploads.begin"] = () => stillUploading.promise;
    fireEvent.click(reopen);

    const password = await screen.findByLabelText("Password");

    expect(screen.queryByText("map.png")).toBeNull();
    expect(api.callsTo("uploads.begin")).toHaveLength(1);

    fireEvent.change(password, { target: { value: "hunter22!" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    await waitFor(() => expect(api.callsTo("uploads.begin")).toHaveLength(2));

    const [first, second] = api.callsTo("uploads.begin");

    expect(second?.input).toEqual(first?.input ?? {});
    expect(await screen.findAllByText("held.bin")).toHaveLength(1);
  });

  test("moving between folders of one link keeps its access and upload queue", async () => {
    const uploadable = { ...VIEWER_ACCESS, role: "contributor", canUpload: true } as const;
    const folder = { ...SHARED_FOLDER, access: uploadable };

    const subfolder = folderEntry({
      id: "folder_t",
      name: "Day one",
      parentId: folder.id,
      access: uploadable,
    });

    const held = deferred<object>();
    const api = publicApi();

    api.handlers["shares.resolve"] = () => ({ ...OPENED, item: folder });
    api.handlers["uploads.begin"] = () => held.promise;

    api.handlers["files.list"] = ({ parentId }) =>
      parentId === subfolder.id
        ? fileList([], subfolder, [{ id: subfolder.id, name: subfolder.name }])
        : fileList([INSIDE], folder, [{ id: folder.id, name: folder.name }]);

    const view = await openLinkIn(api);
    const picker = view.container.querySelector('input[type="file"]');

    if (picker === null) throw new Error("The folder rendered no file picker.");

    fireEvent.change(picker, { target: { files: [new File(["bytes"], "held.bin")] } });
    await waitFor(() => expect(api.callsTo("uploads.begin")).toHaveLength(1));
    await screen.findByText("held.bin");

    view.rerender(<CloudScreen path="/share/token_1/folder_t" onNavigate={() => {}} />);
    await screen.findByText("This folder is empty");

    expect(screen.queryByRole("button", { name: "Open shared item" })).toBeNull();
    expect(screen.getByText("held.bin")).toBeTruthy();
    expect(api.callsTo("shares.resolve")).toHaveLength(1);
    expect(api.callsTo("uploads.begin")).toHaveLength(1);

    view.rerender(<CloudScreen path="/share/token_1" onNavigate={() => {}} />);
    await screen.findByText("map.png");

    expect(screen.getByText("held.bin")).toBeTruthy();
    expect(api.callsTo("shares.resolve")).toHaveLength(1);
  });

  test("a download failure on one public link does not leak into another link", async () => {
    const document = fileEntry({
      id: "shared_document",
      name: "shared.txt",
      mimeType: "text/plain",
      parentId: SHARED_FOLDER.id,
      access: VIEWER_ACCESS,
    });

    const api = publicApi();
    api.handlers["files.list"] = () => fileList([document], SHARED_FOLDER, []);
    api.handlers["files.download"] = () => {
      throw new ApiFailure("auth.required");
    };

    const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    fireEvent.click(await screen.findByRole("button", { name: /^shared\.txt/ }));
    await screen.findByRole("button", { name: "Open link again" });
    view.rerender(<CloudScreen path="/share/token_2" onNavigate={() => {}} />);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    await screen.findByRole("button", { name: /^shared\.txt/ });
    expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull();
    expect(screen.queryByText("Your access through this link has ended")).toBeNull();
  });

  test("one successful reopen acknowledges every failure covered by the link recovery", async () => {
    const first = fileEntry({
      id: "doc_first",
      name: "first.txt",
      mimeType: "text/plain",
      parentId: SHARED_FOLDER.id,
      access: VIEWER_ACCESS,
    });

    const second = fileEntry({
      id: "doc_second",
      name: "second.txt",
      mimeType: "text/plain",
      parentId: SHARED_FOLDER.id,
      access: VIEWER_ACCESS,
    });

    const api = publicApi();
    api.handlers["files.list"] = () => fileList([first, second], SHARED_FOLDER, []);
    api.handlers["files.download"] = ({ id }) => {
      throw new ApiFailure(id === first.id ? "auth.required" : "access.denied");
    };

    const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    fireEvent.click(await screen.findByRole("button", { name: /^first\.txt/ }));
    fireEvent.click(screen.getByRole("button", { name: /^second\.txt/ }));
    await waitFor(() => expect(api.callsTo("files.download")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("status", { name: "Working on second.txt" })).toBeNull(),
    );
    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));
    await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull(),
    );
    expect(screen.queryByText("Your access through this link has ended")).toBeNull();
    expect(screen.getByRole("button", { name: /^first\.txt/ })).toBeTruthy();
    expect(api.callsTo("shares.resolve")).toHaveLength(2);
    expect(view.container.querySelector('[role="alert"]')).toBeNull();
  });

  test("a single-file link recovers a failed download and clears the failure", async () => {
    const file = fileEntry({ id: "file_only", name: "report.pdf", access: VIEWER_ACCESS });

    const api = createFakeApi({
      "shares.resolve": () => ({ ...OPENED, item: file }),
      "files.download": () => {
        throw new ApiFailure("auth.required");
      },
    });

    mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
    fireEvent.click(await screen.findByRole("button", { name: "Download" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));

    await waitFor(() => expect(api.callsTo("shares.resolve")).toHaveLength(2));
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Open link again" })).toBeNull(),
    );
    expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
  });

  describe("a single-file link keeps what it shows current", () => {
    const FILE = fileEntry({
      id: "file_only",
      name: "report.pdf",
      size: 2048,
      access: VIEWER_ACCESS,
    });

    async function openFile() {
      const api = createFakeApi({
        "shares.resolve": () => ({ ...OPENED, item: FILE }),
        "files.get": () => FILE,
      });

      const view = mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);

      fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));
      await screen.findByRole("heading", { name: FILE.name });

      return { api, view };
    }

    test("a rename or new size shows up on refresh", async () => {
      const { api, view } = await openFile();

      api.handlers["files.get"] = () => ({ ...FILE, name: "renamed.pdf", size: 4096 });
      await view.refetchActive();

      await screen.findByRole("heading", { name: "renamed.pdf" });
      expect(screen.getByText("4 KB")).toBeTruthy();
    });

    test("a brief failure keeps the file on screen and usable", async () => {
      const { api, view } = await openFile();

      api.handlers["files.get"] = () => {
        throw new ApiFailure("service.unavailable");
      };

      await view.refetchActive();

      await screen.findByText(/This may be out of date/);
      expect(screen.getByRole("heading", { name: FILE.name })).toBeTruthy();
      expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
    });

    test("a failed download on a revoked link says the link is gone once reopening is refused", async () => {
      const { api } = await openFile();

      api.handlers["files.download"] = () => {
        throw new ApiFailure("access.denied");
      };

      api.handlers["shares.resolve"] = () => {
        throw new ApiFailure("access.denied");
      };

      fireEvent.click(screen.getByRole("button", { name: "Download" }));
      fireEvent.click(await screen.findByRole("button", { name: "Open link again" }));

      await screen.findByText("This link is no longer available");
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });

    test("revoked access stops showing the file, and recovery brings it back", async () => {
      const { api, view } = await openFile();

      api.handlers["files.get"] = () => {
        throw new ApiFailure("access.denied");
      };

      await view.refetchActive();

      await screen.findByRole("heading", { name: "Your access through this link has ended" });
      expect(screen.queryByText(FILE.name)).toBeNull();
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();

      api.handlers["files.get"] = () => FILE;
      fireEvent.click(screen.getByRole("button", { name: "Open link again" }));

      await screen.findByRole("heading", { name: FILE.name });
      expect(screen.getByRole("button", { name: "Download" })).toBeTruthy();
      expect(api.callsTo("shares.resolve")).toHaveLength(2);
    });

    test("a file that's gone says so, and stops offering it", async () => {
      const { api, view } = await openFile();

      api.handlers["files.get"] = () => {
        throw new ApiFailure("resource.notFound");
      };

      await view.refetchActive();

      await screen.findByRole("heading", { name: "This is no longer here" });
      expect(screen.queryByText(FILE.name)).toBeNull();
      expect(screen.queryByRole("button", { name: "Download" })).toBeNull();
      expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    });
  });
});
