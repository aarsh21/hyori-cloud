import { describe, expect } from "bun:test";
import type { FileEntry } from "@hyori-cloud/client-sdk";
import { cleanup } from "@testing-library/react";
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
  VIEWER_ACCESS,
  waitFor,
} from "#features-test/mounted.tsx";

/**
 * Real SDK, queue, and Query over a transport shaped like the public upload contract. This proves
 * the browser's side of the flow only; the Rust server's replacement behavior has its own tests.
 */

const REPORT = fileEntry({
  id: "file_1",
  name: "report.pdf",
  size: 7,
  mimeType: "application/pdf",
});

const UPLOAD_ID = "upload_1";
const AUTH = { initialized: true, user: SIGNED_IN_USER };

function uploadStatus(state: "uploading" | "aborted", size: number) {
  return {
    uploadId: UPLOAD_ID,
    chunkSize: 1024,
    totalParts: Math.max(1, Math.ceil(size / 1024)),
    parts: [],
    state,
    fileId: null,
  };
}

type Replacement = { size: number; state: "uploading" | "aborted" };

function uploadApi(entry: FileEntry = REPORT) {
  const replacement: Replacement = { size: 0, state: "uploading" };
  let current = entry;

  const api = createFakeApi({
    "auth.status": () => AUTH,
    "files.list": () => fileList([current]),
    "files.get": () => current,
    "uploads.begin": (input) => {
      replacement.size = Number(input.size);

      return uploadStatus("uploading", replacement.size);
    },
    "uploads.status": () => uploadStatus(replacement.state, replacement.size),
    "uploads.part": () => ({ url: "/parts/1", method: "PUT", headers: {} }),
    "uploads.abort": () => {
      replacement.state = "aborted";

      return { success: true };
    },
    "uploads.complete": () => {
      current = { ...current, size: replacement.size, updatedAt: "2026-11-05T00:00:00Z" };

      return current;
    },
  });

  // Part bytes go to a storage URL rather than an RPC. A rejected part is not retried by the SDK.
  const putResults: number[] = [];
  const puts: string[] = [];
  let heldUntil: Promise<void> | null = null;

  return {
    ...api,
    putResults,
    puts,
    holdPutsUntil(release: Promise<void> | null) {
      heldUntil = release;
    },
    fetch: (async (url, init) => {
      if (init?.method !== "PUT") return api.fetch(url, init);
      puts.push(String(url));
      await heldUntil;

      return new Response(null, { status: putResults.shift() ?? 200 });
    }) satisfies typeof api.fetch,
  };
}

function openFiles(api: ReturnType<typeof uploadApi>) {
  return mount(<CloudScreen path="/" onNavigate={() => {}} />, api);
}

async function openRowMenu(name = "report.pdf") {
  fireEvent.click(await screen.findByRole("button", { name: `Actions for ${name}` }));
}

async function openReplaceDialog() {
  await openRowMenu();
  fireEvent.click(await screen.findByRole("menuitem", { name: "Upload new version…" }));

  // Opening now has a cancellable loading modal. Wait for the requested form, not that progress UI.
  return waitFor(() => {
    const dialog = screen.getByRole("dialog");

    if (dialog.querySelector('input[type="file"]') === null)
      throw new Error("The dialog has no file input.");

    return dialog;
  });
}

function chooseSource(dialog: HTMLElement, file: File) {
  const input = dialog.querySelector<HTMLInputElement>('input[type="file"]');

  if (input === null) throw new Error("The dialog has no file input.");
  fireEvent.change(input, { target: { files: [file] } });
}

const SOURCE = new File(["new contents"], "report (final).pdf", {
  type: "application/pdf",
  lastModified: 1,
});

async function confirmNewVersion(api: ReturnType<typeof uploadApi>, source = SOURCE) {
  const dialog = await openReplaceDialog();

  chooseSource(dialog, source);
  fireEvent.click(await screen.findByRole("button", { name: "Upload new version" }));

  return api;
}

describe("uploading a new version", () => {
  test("is offered to people who can edit, and only on files", async () => {
    const folder = folderEntry({ id: "folder_1", name: "Trips" });
    const api = uploadApi();

    api.handlers["files.list"] = () => fileList([REPORT, folder]);
    openFiles(api);

    await openRowMenu("Trips");
    await screen.findByRole("menuitem", { name: /Rename/ });
    expect(screen.queryByRole("menuitem", { name: "Upload new version…" })).toBeNull();
  });

  test("isn't offered to a viewer", async () => {
    const api = uploadApi(fileEntry({ id: "file_2", name: "read.pdf", access: VIEWER_ACCESS }));

    openFiles(api);
    await openRowMenu("read.pdf");
    await screen.findByRole("menuitem", { name: "Download" });

    expect(screen.queryByRole("menuitem", { name: "Upload new version…" })).toBeNull();
  });

  test("choosing a file starts nothing until it's confirmed", async () => {
    const api = uploadApi();

    openFiles(api);
    const dialog = await openReplaceDialog();
    const confirm = screen.getByRole("button", { name: "Upload new version" });

    expect(confirm.hasAttribute("disabled")).toBe(true);

    chooseSource(dialog, SOURCE);
    await screen.findByText(/report \(final\)\.pdf/);

    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(api.callsTo("uploads.begin")).toEqual([]);
  });

  test("says when the local name differs, and cancelling leaves no trace", async () => {
    const api = uploadApi();

    openFiles(api);
    const dialog = await openReplaceDialog();

    chooseSource(dialog, SOURCE);
    await screen.findByText("It will be saved as “report.pdf”.");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    const reopened = await openReplaceDialog();

    expect(reopened.textContent).toContain("No file chosen");
    expect(api.callsTo("uploads.begin")).toEqual([]);
  });

  test("replaces under the file's own name and reconciles the listing", async () => {
    const api = uploadApi();

    openFiles(api);
    await confirmNewVersion(api);
    await screen.findByLabelText("Uploaded");

    const [begin] = api.callsTo("uploads.begin");

    expect(begin?.input).toMatchObject({
      replaceId: REPORT.id,
      parentId: null,
      name: "report.pdf",
      size: SOURCE.size,
    });
    expect(api.callsTo("uploads.complete")).toHaveLength(1);
    expect(screen.getByText("New version")).toBeTruthy();

    // The listing refreshes through the central policy, with nothing feature-owned invalidating it.
    await waitFor(() => expect(api.callsTo("files.list").length).toBeGreaterThan(1));
  });

  test("a failed part makes no claim about the file, and can be retried", async () => {
    const api = uploadApi();

    api.putResults.push(403);
    openFiles(api);
    await confirmNewVersion(api);
    await screen.findByText(/Couldn’t confirm the new version\./);
    expect(screen.queryByText(/unchanged|wasn’t saved/)).toBeNull();

    expect(api.callsTo("uploads.complete")).toEqual([]);

    const listed = api.callsTo("files.list").length;
    const retry = screen.getByRole("button", { name: "Retry upload of report.pdf" });

    retry.focus();
    fireEvent.click(retry);
    await screen.findByLabelText("Uploaded");

    expect(api.callsTo("uploads.begin")).toHaveLength(1);
    await waitFor(() => expect(api.callsTo("files.list").length).toBeGreaterThan(listed));
  });

  test("a conflict says only that, and offers cancelling rather than a retry", async () => {
    const api = uploadApi();

    api.handlers["uploads.complete"] = () => {
      throw new ApiFailure("resource.conflict", "Resource conflicts with existing state");
    };

    openFiles(api);
    await confirmNewVersion(api);
    await screen.findByText(/The server reported a conflict/);

    expect(screen.queryByText(/Resource conflicts|changed during|already here/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Retry upload of report.pdf" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel upload of report.pdf" }));
    await screen.findByText(/^Cancelled\./);
    expect(api.callsTo("uploads.abort")).toHaveLength(1);
  });

  test("version history offers the same flow to someone who can edit", async () => {
    const api = uploadApi();

    api.handlers["files.versions"] = () => ({ items: [], nextCursor: null });
    openFiles(api);

    await openRowMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Version history…" }));
    await screen.findByText("No earlier versions yet.");
    expect(screen.getByText("Current")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Upload new version…" }));
    await screen.findByText("No file chosen");
  });

  test("a successful restore says so, naming the version", async () => {
    const api = uploadApi();

    api.handlers["files.versions"] = () => ({
      items: [{ id: "v1", fileId: REPORT.id, size: 3, createdAt: "2026-11-01T00:00:00Z" }],
      nextCursor: null,
    });
    api.handlers["files.restoreVersion"] = () => REPORT;
    openFiles(api);

    await openRowMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Version history…" }));
    fireEvent.click(await screen.findByRole("button", { name: "Restore" }));

    await screen.findByText(/Restored the version from/);
  });
});

describe("a commit whose reply is lost", () => {
  // An explicit protocol fake: the server commits and the client never hears. It shows what the UI
  // says and does with that outcome, not that a real server behaves this way.
  function committedThenLost(lose: () => never) {
    const api = uploadApi();
    let committed = false;

    api.handlers["uploads.status"] = () => ({
      ...uploadStatus("uploading", SOURCE.size),
      state: committed ? "complete" : "uploading",
      fileId: committed ? REPORT.id : null,
    });

    api.handlers["uploads.complete"] = () => {
      if (committed) return { ...REPORT, size: SOURCE.size };
      committed = true;

      return lose();
    };

    return api;
  }

  const LOST_REPLIES: readonly (readonly [string, () => never])[] = [
    [
      "the server answering that it's unavailable",
      () => {
        throw new ApiFailure("service.unavailable");
      },
    ],
    [
      "the connection dropping",
      () => {
        throw new Error("The connection closed.");
      },
    ],
  ];

  for (const [how, lose] of LOST_REPLIES) {
    test(`after ${how}, nothing claims the file is unchanged, and Retry reconciles`, async () => {
      const api = committedThenLost(lose);

      openFiles(api);
      await confirmNewVersion(api);
      await screen.findByText(/Couldn’t confirm the new version\./);

      expect(screen.queryByText(/unchanged|wasn’t saved|nothing/i)).toBeNull();
      expect(screen.getByText(/check the file before starting again/)).toBeTruthy();
      expect(screen.queryByLabelText("Uploaded")).toBeNull();

      const listed = api.callsTo("files.list").length;

      fireEvent.click(screen.getByRole("button", { name: "Retry upload of report.pdf" }));
      await screen.findByLabelText("Uploaded");

      // The same upload found out what happened: nothing began again and no bytes were resent.
      expect(api.callsTo("uploads.begin")).toHaveLength(1);
      expect(api.puts).toHaveLength(1);
      expect(api.callsTo("uploads.complete")).toHaveLength(2);
      await waitFor(() => expect(api.callsTo("files.list").length).toBeGreaterThan(listed));
    });
  }
});

describe("a new version whose local file has another name", () => {
  const STORE = `hyori.uploads.${SIGNED_IN_USER.id}`;

  const CHECKPOINT = {
    version: 2,
    uploadId: UPLOAD_ID,
    file: {
      name: SOURCE.name,
      size: SOURCE.size,
      type: SOURCE.type,
      lastModified: SOURCE.lastModified,
    },
    intent: { kind: "replacement", name: REPORT.name, targetId: REPORT.id },
  };

  // A queue is disposed one task after its page goes, and it writes its checkpoints then.
  function earlierQueuesDisposed() {
    return act(() => new Promise((settled) => setTimeout(settled, 10)));
  }

  function trayInput() {
    const input = screen
      .getByRole("region", { name: "Uploads" })
      .querySelector<HTMLInputElement>('input[type="file"]');

    if (input === null) throw new Error("The row has no file input.");

    return input;
  }

  function reselect(file: File) {
    fireEvent.change(trayInput(), { target: { files: [file] } });
  }

  test("shows the target's name, never the local one", async () => {
    const api = uploadApi();
    const release = deferred<void>();

    api.holdPutsUntil(release.promise);
    openFiles(api);
    await confirmNewVersion(api);
    await waitFor(() => expect(api.puts).toHaveLength(1));

    const tray = screen.getByRole("region", { name: "Uploads" });

    expect(tray.textContent).toContain(REPORT.name);
    expect(tray.textContent).toContain("New version");
    expect(tray.textContent).not.toContain(SOURCE.name);

    release.resolve();
    await screen.findByLabelText("Uploaded");
  });

  test("survives a reload: its checkpoint keeps both identities, and only the original resumes", async () => {
    const api = uploadApi();
    const release = deferred<void>();

    api.holdPutsUntil(release.promise);
    openFiles(api);
    await confirmNewVersion(api);
    await waitFor(() => expect(api.puts).toHaveLength(1));

    expect(JSON.parse(localStorage.getItem(STORE) ?? "[]")).toEqual([CHECKPOINT]);

    // Leaving the page disposes the queue, keeping the checkpoint for later.
    cleanup();
    await earlierQueuesDisposed();
    api.holdPutsUntil(null);
    release.resolve();
    openFiles(api);

    await screen.findByText(`Interrupted. Choose “${SOURCE.name}” again to continue.`);

    const tray = screen.getByRole("region", { name: "Uploads" });

    expect(tray.textContent).toContain(REPORT.name);
    expect(tray.textContent).toContain("New version");

    // Having the target's name doesn't make a file the one this upload started from.
    reselect(new File(["other"], REPORT.name, { type: "application/pdf", lastModified: 2 }));
    await screen.findByText(
      `That isn’t the same file. Choose “${SOURCE.name}”, unchanged, to continue.`,
    );
    expect(api.callsTo("uploads.status")).toHaveLength(1);

    reselect(SOURCE);
    await screen.findByLabelText("Uploaded");

    expect(screen.getByRole("region", { name: "Uploads" }).textContent).toContain("New version");
    expect(api.callsTo("uploads.begin")).toHaveLength(1);
    expect(api.callsTo("uploads.complete")).toHaveLength(1);
    expect(localStorage.getItem(STORE)).toBeNull();
  });

  test("resumed after a reload, a conflict still reads as one and offers no retry", async () => {
    const api = uploadApi();

    api.handlers["uploads.complete"] = () => {
      throw new ApiFailure("resource.conflict", "Resource conflicts with existing state");
    };

    await earlierQueuesDisposed();
    localStorage.setItem(STORE, JSON.stringify([CHECKPOINT]));
    openFiles(api);

    await screen.findByText(`Interrupted. Choose “${SOURCE.name}” again to continue.`);
    reselect(SOURCE);
    await screen.findByText(/The server reported a conflict, so this new version/);

    expect(screen.queryByRole("button", { name: `Retry upload of ${REPORT.name}` })).toBeNull();
    expect(screen.queryByText(/possibly an item with this name/)).toBeNull();
  });

  test("a checkpoint from before intents existed is never treated as a replacement", async () => {
    const api = uploadApi();
    const { intent: _unrecorded, ...fields } = CHECKPOINT;

    api.handlers["uploads.complete"] = () => {
      throw new ApiFailure("resource.conflict", "Resource conflicts with existing state");
    };

    await earlierQueuesDisposed();
    localStorage.setItem(STORE, JSON.stringify([{ ...fields, version: 1 }]));
    openFiles(api);

    await screen.findByText(`Interrupted. Choose “${SOURCE.name}” again to continue.`);

    const tray = screen.getByRole("region", { name: "Uploads" });

    expect(tray.textContent).not.toContain("New version");

    reselect(SOURCE);
    await screen.findByText(/It conflicts with something that already exists/);

    // A plain failure: no claim about the existing file or a duplicate, which it can't know.
    expect(screen.queryByText(/new version|possibly an item|unchanged/)).toBeNull();
    expect(screen.getByRole("button", { name: `Retry upload of ${SOURCE.name}` })).toBeTruthy();
  });
});

describe("files added without choosing to replace", () => {
  function refusedAsDuplicate() {
    const api = uploadApi();

    api.handlers["uploads.begin"] = () => {
      throw new ApiFailure("resource.conflict", "Resource conflicts with existing state");
    };

    return api;
  }

  async function expectDuplicateRefused(api: ReturnType<typeof uploadApi>) {
    await screen.findByText(/possibly an item with this name/);

    expect(api.callsTo("uploads.begin")).toHaveLength(1);
    expect(api.callsTo("uploads.begin")[0]?.input.replaceId).toBeUndefined();
    expect(screen.queryByText("New version")).toBeNull();
  }

  test("a dropped file sharing a name is a new upload, refused and never replaced", async () => {
    const api = refusedAsDuplicate();

    openFiles(api);
    await screen.findByText(REPORT.name);

    const zone = document.querySelector('[data-slot="drop-zone"]');

    if (zone === null) throw new Error("The page has no drop zone.");
    fireEvent.drop(zone, {
      dataTransfer: { types: ["Files"], files: [new File(["x"], REPORT.name)] },
    });

    await expectDuplicateRefused(api);
  });

  test("a picked file sharing a name is too", async () => {
    const api = refusedAsDuplicate();

    openFiles(api);
    await screen.findByText(REPORT.name);

    const input = document.querySelector<HTMLInputElement>('input[type="file"]');

    if (input === null) throw new Error("The page has no file input.");
    fireEvent.change(input, { target: { files: [new File(["x"], REPORT.name)] } });

    await expectDuplicateRefused(api);
  });
});

describe("a public link to a single file", () => {
  const EDITOR_ACCESS = { ...VIEWER_ACCESS, role: "editor", canEdit: true } as const;
  const SHARED = fileEntry({ id: "file_3", name: "brief.txt", size: 7, access: EDITOR_ACCESS });

  const SHARE = {
    id: "share_1",
    itemId: SHARED.id,
    role: "editor",
    recipientId: null,
    public: true,
    expiresAt: null,
    passwordProtected: false,
    revokedAt: null,
    url: null,
  } as const;

  async function openLink(item: FileEntry) {
    const api = uploadApi(item);

    api.handlers["shares.resolve"] = () => ({ share: SHARE, item, requiresPassword: false });
    mount(<CloudScreen path="/share/token_1" onNavigate={() => {}} />, api);
    fireEvent.click(await screen.findByRole("button", { name: "Open shared item" }));

    return api;
  }

  test("opening it asks for nothing more than the link already answered", async () => {
    const api = await openLink(SHARED);

    await screen.findByRole("button", { name: "Upload new version" });

    expect(api.callsTo("files.get")).toEqual([]);
  });

  test("an editor can replace it, and the page stays current after the tray is cleared", async () => {
    const api = await openLink(SHARED);

    fireEvent.click(await screen.findByRole("button", { name: "Upload new version" }));

    const dialog = await screen.findByRole("dialog");

    chooseSource(dialog, new File(["0123456789"], "brief.txt", { type: "text/plain" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Upload new version", hidden: false }),
    );

    await screen.findByLabelText("Uploaded");

    // Nothing here asks for this: the declared policy for finishing an upload does.
    await waitFor(() =>
      expect(api.callsTo("files.get")).toEqual([
        { operation: "files.get", input: { id: SHARED.id } },
      ]),
    );
    expect(api.callsTo("uploads.begin")[0]?.input.replaceId).toBe(SHARED.id);

    fireEvent.click(await screen.findByRole("button", { name: "Clear" }));
    await waitFor(() => expect(screen.queryByLabelText("Uploaded")).toBeNull());

    expect(screen.getByText("10 B")).toBeTruthy();
    expect(screen.queryByText("7 B")).toBeNull();
  });

  test("a viewer isn't offered it", async () => {
    await openLink({ ...SHARED, access: VIEWER_ACCESS });

    await screen.findByRole("button", { name: "Download" });

    expect(screen.queryByRole("button", { name: "Upload new version" })).toBeNull();
  });
});
