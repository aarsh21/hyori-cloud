import { afterEach, describe, expect } from "bun:test";
import type { Share } from "@hyori-cloud/client-sdk";
import { ShareDialog } from "#features/sharing/react/share-dialog.tsx";
import {
  ApiFailure,
  createFakeApi,
  deferred,
  fileEntry,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";
import type { RequestInput } from "#features-test/mounted.tsx";

const ROOT_FILE = fileEntry({ id: "file_1", name: "a.pdf" });
const NESTED_FILE = fileEntry({ id: "file_1", name: "a.pdf", parentId: "folder_1" });

const LINK = {
  id: "share_1",
  itemId: ROOT_FILE.id,
  role: "viewer",
  recipientId: null,
  recipient: null,
  public: true,
  expiresAt: null,
  passwordProtected: false,
  revokedAt: null,
  url: null,
} as const;

const GRACE = { id: "user_2", name: "Grace Hopper", email: "grace@example.com" } as const;

const PERSON = {
  ...LINK,
  id: "share_2",
  public: false,
  recipientId: GRACE.id,
  recipient: GRACE,
} as const;

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

/** Every dialog suite needs the signed-in owner and an empty directory to start from. */
function shareApi(handlers: Record<string, (input: RequestInput) => object> = {}) {
  return createFakeApi({
    "auth.status": () => ({ initialized: true, user: SIGNED_IN_USER }),
    "shares.list": () => ({ items: [] }),
    "users.search": () => ({ items: [] }),
    ...handlers,
  });
}

function renderDialog(api: ReturnType<typeof createFakeApi>, entry = ROOT_FILE) {
  return mount(<ShareDialog entry={entry} open onOpenChange={() => {}} />, api);
}

async function recipientField() {
  return screen.findByRole<HTMLInputElement>("combobox", { name: "Add people by name or email" });
}

/**
 * Types as a browser does. Base UI only opens its popup for input events that carry an input type;
 * a bare `change` event reads as autofill and keeps the list closed.
 */
async function typeToFind(text: string) {
  const field = await recipientField();

  fireEvent.focus(field);
  fireEvent.input(field, { target: { value: text }, inputType: "insertText" });
}

/** Base UI commits a mouse selection only for a press that started on the option. */
function pickOption(name: RegExp | string) {
  const option = screen.getByRole("option", { name });

  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

async function chooseRole(label: string, role: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));

  const option = await screen.findByRole("option", { name: new RegExp(role) });

  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);

  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: label }).textContent).toContain(role),
  );
}

function stubClipboard() {
  const written: string[] = [];

  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: async (text: string) => void written.push(text) },
  });

  return written;
}

describe("what the dialog claims about access", () => {
  test("never promises that only listed people can open an item", async () => {
    renderDialog(shareApi());

    expect(await screen.findByText(/No public links yet/)).toBeTruthy();
    expect(screen.queryByText(/Only the people above/)).toBeNull();
  });

  test("says a parent folder's sharing still applies to a nested item", async () => {
    renderDialog(shareApi(), NESTED_FILE);

    expect(await screen.findByText(/Access shared on a parent folder still applies/)).toBeTruthy();
  });
});

describe("adding a person", () => {
  test("finds people by name and shares with the highlighted suggestion", async () => {
    const created: Share[] = [];

    const api = shareApi({
      "users.search": () => ({ items: [GRACE] }),
      "shares.create": (input) => {
        // SAFETY: the dialog only sends ShareRole values; this handler echoes its input back.
        const share = { ...PERSON, role: input.role as Share["role"] };

        created.push(share);

        return share;
      },
    });

    renderDialog(api);
    // The field is held, not re-queried: while the suggestion popup is open, Base UI hides
    // background content from the accessibility tree, so name queries stop matching mid-test.
    const field = await recipientField();
    fireEvent.focus(field);
    fireEvent.input(field, { target: { value: "grace" }, inputType: "insertText" });
    await screen.findByRole("option", { name: /Grace Hopper/ });

    fireEvent.keyDown(field, { key: "Enter" });

    await waitFor(() => expect(api.callsTo("shares.create")).toHaveLength(1));
    expect(api.callsTo("shares.create")[0]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: "viewer",
      public: false,
      recipientId: GRACE.id,
    });

    expect(field.value).toBe("");
    expect(screen.getByText("Grace Hopper")).toBeTruthy();
    expect(screen.getByText(GRACE.email)).toBeTruthy();
    expect(created[0]).toEqual({ ...PERSON, role: "viewer" });
  });

  test("a failed add keeps what was typed, even after an earlier success", async () => {
    const api = shareApi({
      "users.search": () => ({ items: [GRACE] }),
      "shares.create": () => PERSON,
    });

    renderDialog(api);
    // Held for the same popup-open reason as the Enter test above.
    const field = await recipientField();
    fireEvent.focus(field);
    fireEvent.input(field, { target: { value: "grace" }, inputType: "insertText" });
    await screen.findByRole("option", { name: /Grace Hopper/ });
    pickOption(/Grace Hopper/);

    await waitFor(() => expect(api.callsTo("shares.create")).toHaveLength(1));
    await waitFor(() => expect(field.value).toBe(""));

    api.handlers["shares.create"] = () => {
      throw new ApiFailure("resource.conflict");
    };

    fireEvent.input(field, { target: { value: "mia" }, inputType: "insertText" });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(await screen.findByText("Couldn’t share with mia")).toBeTruthy();
    // The field the user sees keeps the typed text to correct; the name query can't match while
    // the reopened popup hides background content, so assert against the live input itself.
    expect(screen.getByPlaceholderText<HTMLInputElement>("Name or email").value).toBe("mia");
    expect(api.callsTo("shares.create")[1]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: "viewer",
      public: false,
      recipientId: "mia",
    });
  });

  test("the next person starts at Viewer after a success", async () => {
    const api = shareApi({
      "users.search": () => ({ items: [GRACE] }),
      "shares.create": () => ({ ...PERSON, role: "editor" }),
    });

    renderDialog(api);

    // The role is chosen before searching: while the suggestion popup is open, the role select
    // sits in the hidden background, so a user reaches it either earlier or after the popup
    // closes. The field is awaited first because the body mounts as one skeleton.
    const field = await recipientField();
    await chooseRole("Role for this person", "Editor");
    fireEvent.focus(field);
    fireEvent.input(field, { target: { value: "grace" }, inputType: "insertText" });
    await screen.findByRole("option", { name: /Grace Hopper/ });
    pickOption(/Grace Hopper/);

    await waitFor(() => expect(api.callsTo("shares.create")).toHaveLength(1));
    expect(api.callsTo("shares.create")[0]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: "editor",
      public: false,
      recipientId: GRACE.id,
    });
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Role for this person" }).textContent).toContain(
        "Viewer",
      ),
    );
    await waitFor(async () => expect((await recipientField()).value).toBe(""));
  });

  test("a grant in flight shows as the person's row, without controls", async () => {
    const created = deferred<object>();

    const api = shareApi({
      "users.search": () => ({ items: [GRACE] }),
      "shares.create": () => created.promise,
    });

    renderDialog(api);
    await typeToFind("grace");
    await screen.findByRole("option", { name: /Grace Hopper/ });
    pickOption(/Grace Hopper/);

    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Remove" })).toBeNull();
    expect(screen.queryByRole("combobox", { name: "Grace Hopper’s role" })).toBeNull();
    expect(api.callsTo("shares.create")).toHaveLength(1);

    created.resolve(PERSON);

    expect(await screen.findByRole("combobox", { name: "Grace Hopper’s role" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  test("suggests no one who already has access", async () => {
    renderDialog(
      shareApi({
        "shares.list": () => ({ items: [PERSON] }),
        "users.search": () => ({ items: [GRACE] }),
      }),
    );

    await typeToFind("grace");

    expect(await screen.findByText("Everyone matching already has access.")).toBeTruthy();
    expect(screen.queryByRole("option", { name: /Grace Hopper/ })).toBeNull();
  });

  test("reports the server's rate limit instead of hiding it", async () => {
    renderDialog(
      shareApi({
        "users.search": () => {
          throw new ApiFailure("auth.rateLimited");
        },
      }),
    );

    await typeToFind("gr");

    expect(await screen.findByText("Too many attempts. Wait a moment and try again.")).toBeTruthy();
    expect(screen.queryByRole("option")).toBeNull();
  });

  test("searches once per pause, not one keystroke at a time", async () => {
    const api = shareApi({ "users.search": () => ({ items: [GRACE] }) });

    renderDialog(api);

    const field = await recipientField();

    for (const text of ["gr", "gra", "grace"]) {
      fireEvent.input(field, { target: { value: text }, inputType: "insertText" });
    }

    await waitFor(() => expect(api.callsTo("users.search")).toHaveLength(1));
    expect(api.callsTo("users.search")[0]?.input).toEqual({ query: "grace" });
  });
});

describe("who has access", () => {
  test("shows the owner and each person with their granted role", async () => {
    renderDialog(shareApi({ "shares.list": () => ({ items: [PERSON] }) }));

    expect(await screen.findByText("You")).toBeTruthy();
    expect(screen.getByText("Owner")).toBeTruthy();
    expect(screen.getByText(SIGNED_IN_USER.email)).toBeTruthy();

    expect(screen.getByRole("combobox", { name: "Grace Hopper’s role" }).textContent).toContain(
      "Viewer",
    );
    expect(screen.getByText(GRACE.email)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove" })).toBeTruthy();
  });

  test("changing a role asks the server and keeps the new role", async () => {
    let granted: Share = PERSON;

    const api = shareApi({
      "shares.list": () => ({ items: [granted] }),
      "shares.update": (input) => {
        // SAFETY: the dialog only sends ShareRole values; this handler echoes its input back.
        granted = { ...granted, role: input.role as Share["role"] };

        return granted;
      },
    });

    renderDialog(api);
    await screen.findByRole("combobox", { name: "Grace Hopper’s role" });
    await chooseRole("Grace Hopper’s role", "Editor");

    expect(api.callsTo("shares.update")).toHaveLength(1);
    expect(api.callsTo("shares.update")[0]?.input).toEqual({ id: PERSON.id, role: "editor" });
    expect(screen.getByRole("combobox", { name: "Grace Hopper’s role" }).textContent).toContain(
      "Editor",
    );
  });

  test("a failed role change rolls back and names the person", async () => {
    renderDialog(
      shareApi({
        "shares.list": () => ({ items: [PERSON] }),
        "shares.update": () => {
          throw new ApiFailure("service.unavailable");
        },
      }),
    );

    await screen.findByRole("combobox", { name: "Grace Hopper’s role" });
    // Not chooseRole: its settle check wants the role to become Editor, which this rollback never
    // shows. The contract here is the failed request and the restored Viewer.
    fireEvent.click(screen.getByRole("combobox", { name: "Grace Hopper’s role" }));
    await screen.findByRole("option", { name: /Editor/ });
    pickOption(/Editor/);

    expect(await screen.findByText("Couldn’t change Grace Hopper to Editor")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Grace Hopper’s role" }).textContent).toContain(
      "Viewer",
    );
  });

  test("removing a person is optimistic and undoable with the same role", async () => {
    const api = shareApi({
      "shares.list": () => ({ items: [PERSON] }),
      "shares.revoke": () => {
        api.handlers["shares.list"] = () => ({ items: [] });

        return { success: true };
      },
      "shares.create": (input) => {
        api.handlers["shares.list"] = () => ({ items: [PERSON] });

        // SAFETY: the dialog only sends ShareRole values; this handler echoes its input back.
        return { ...PERSON, role: input.role as Share["role"] };
      },
    });

    renderDialog(api);
    await screen.findByText("Grace Hopper");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(screen.queryByText("Grace Hopper")).toBeNull());
    expect(api.callsTo("shares.revoke")).toHaveLength(1);

    const undo = await screen.findByRole("button", { name: "Undo" });

    expect(screen.getByText("Removed Grace Hopper’s access")).toBeTruthy();

    fireEvent.click(undo);

    await waitFor(() => expect(api.callsTo("shares.create")).toHaveLength(1));
    expect(api.callsTo("shares.create")[0]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: PERSON.role,
      public: false,
      recipientId: GRACE.id,
    });
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  });

  test("a failed removal rolls back beside the list", async () => {
    renderDialog(
      shareApi({
        "shares.list": () => ({ items: [PERSON] }),
        "shares.revoke": () => {
          throw new ApiFailure("service.unavailable");
        },
      }),
    );

    await screen.findByText("Grace Hopper");

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(await screen.findByText("Couldn’t remove Grace Hopper")).toBeTruthy();
    expect(await screen.findByText("Grace Hopper")).toBeTruthy();
  });
});

describe("a link's one-time URL", () => {
  async function copyLink() {
    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    return screen.findByRole<HTMLInputElement>("textbox", { name: "Public link" });
  }

  test("one click creates a Viewer link and copies the absolute URL", async () => {
    const written = stubClipboard();

    const api = shareApi({
      "shares.create": () => {
        api.handlers["shares.list"] = () => ({ items: [{ ...LINK, url: "/share/secret_token" }] });

        return { ...LINK, url: "/share/secret_token" };
      },
    });

    renderDialog(api);

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));

    await waitFor(() => expect(written).toEqual(["http://hyori.test/share/secret_token"]));
    expect(api.callsTo("shares.create")[0]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: "viewer",
      public: true,
      expiresAt: null,
    });
    expect(await screen.findByText("Copied")).toBeTruthy();

    const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Public link" });

    expect(field.value).toBe("http://hyori.test/share/secret_token");
  });

  test("stays reachable when the clipboard API doesn't exist", async () => {
    expect(navigator.clipboard).toBeUndefined();

    renderDialog(shareApi({ "shares.create": () => ({ ...LINK, url: "/share/secret_token" }) }));

    const field = await copyLink();

    expect(field.value).toBe("http://hyori.test/share/secret_token");
    expect(
      screen.getByText("Copy this link now. For security it can’t be shown again."),
    ).toBeTruthy();
  });

  test("survives a failed second create, beside a notice about it", async () => {
    const api = shareApi({
      "shares.create": () => ({ ...LINK, url: "/share/first_token" }),
    });

    renderDialog(api);
    await copyLink();

    api.handlers["shares.create"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    fireEvent.click(await screen.findByRole("button", { name: "Copy link" }));
    await screen.findByText("Hyori can’t reach its services");

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Public link" }).value).toBe(
      "http://hyori.test/share/first_token",
    );
  });

  test("ends when the dialog closes", async () => {
    const view = renderDialog(
      shareApi({ "shares.create": () => ({ ...LINK, url: "/share/secret_token" }) }),
    );

    await copyLink();
    view.rerender(<ShareDialog entry={ROOT_FILE} open={false} onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<ShareDialog entry={ROOT_FILE} open onOpenChange={() => {}} />);
    await screen.findByRole("dialog");

    expect(screen.queryByRole("textbox", { name: "Public link" })).toBeNull();
  });

  test("goes away only once that link is revoked", async () => {
    const api = shareApi({
      "shares.create": () => {
        api.handlers["shares.list"] = () => ({ items: [LINK] });

        return { ...LINK, url: "/share/secret_token" };
      },
      "shares.revoke": () => {
        api.handlers["shares.list"] = () => ({ items: [] });

        return { success: true };
      },
    });

    renderDialog(api);
    await copyLink();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Public link" })).toBeNull());
  });
});

describe("link settings", () => {
  async function openSettings() {
    fireEvent.click(await screen.findByRole("button", { name: /Link settings/ }));
    await screen.findByRole("combobox", { name: "Anyone with the link can" });
  }

  test("creates a link with a role, password, and expiry in one pass", async () => {
    const api = shareApi({
      "shares.create": () => {
        api.handlers["shares.list"] = () => ({ items: [{ ...LINK, role: "editor" }] });

        return { ...LINK, role: "editor", url: "/share/editor_token" };
      },
    });

    renderDialog(api);
    await openSettings();
    await chooseRole("Anyone with the link can", "Editor");

    const password = screen.getByLabelText<HTMLInputElement>("Password (optional)");

    fireEvent.change(password, { target: { value: "a long secret" } });

    await chooseRole("Expires", "7 days");
    fireEvent.click(screen.getByRole("button", { name: "Create new link" }));

    await waitFor(() => expect(api.callsTo("shares.create")).toHaveLength(1));

    // End of the local day seven days out, as the picker itself computes it.
    const day = new Date();
    day.setDate(day.getDate() + 7);

    const expected = new Date(
      `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(
        day.getDate(),
      ).padStart(2, "0")}T23:59:59.999`,
    ).toISOString();

    expect(api.callsTo("shares.create")[0]?.input).toEqual({
      itemId: ROOT_FILE.id,
      role: "editor",
      public: true,
      password: "a long secret",
      expiresAt: expected,
    });

    // The next link starts plain again.
    await openSettings();

    expect(
      screen.getByRole("combobox", { name: "Anyone with the link can" }).textContent,
    ).toContain("Viewer");
    expect(screen.getByLabelText<HTMLInputElement>("Password (optional)").value).toBe("");
  });

  test("waits for a custom expiry date before creating", async () => {
    const api = shareApi();

    renderDialog(api);
    await openSettings();
    await chooseRole("Expires", "Custom…");

    const create = screen.getByRole("button", { name: "Create new link" });

    expect(create.hasAttribute("disabled")).toBe(true);

    fireEvent.click(create);

    expect(api.callsTo("shares.create")).toHaveLength(0);
  });
});

describe("a link's row", () => {
  test("tells what someone with the link can do, and what protects it", async () => {
    renderDialog(
      shareApi({
        "shares.list": () => ({
          items: [
            {
              ...LINK,
              role: "editor",
              passwordProtected: true,
              expiresAt: "2999-01-01T00:00:00.000Z",
            },
          ],
        }),
      }),
    );

    expect(await screen.findByText("Anyone with the link · Editor")).toBeTruthy();
    expect(screen.getByText("Password")).toBeTruthy();
    expect(screen.getByText(/Expires /)).toBeTruthy();
  });

  test("says when a link has expired", async () => {
    renderDialog(
      shareApi({
        "shares.list": () => ({
          items: [{ ...LINK, expiresAt: "2000-01-01T00:00:00.000Z" }],
        }),
      }),
    );

    expect(await screen.findByText("Expired")).toBeTruthy();
  });
});

describe("revoking a link", () => {
  test("asks first, and Cancel leaves the link working", async () => {
    const api = shareApi({
      "shares.list": () => ({ items: [LINK] }),
      "shares.revoke": () => ({ success: true }),
    });

    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const confirmation = await screen.findByRole("alertdialog");

    expect(confirmation.textContent).toContain("People using this link lose access now");
    expect(confirmation.textContent).toContain(`link to “${ROOT_FILE.name}”?`);
    expect(api.callsTo("shares.revoke")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    expect(api.callsTo("shares.revoke")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Revoke", hidden: true }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));

    await waitFor(() => expect(api.callsTo("shares.revoke")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });

  test("a failed revoke closes the confirmation and reports beside the link", async () => {
    const api = shareApi({
      "shares.list": () => ({ items: [LINK] }),
      "shares.revoke": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    renderDialog(api);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));

    expect(await screen.findByText("Hyori can’t reach its services")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  });
});
