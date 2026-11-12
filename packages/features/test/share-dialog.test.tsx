import { describe, expect } from "bun:test";
import { ShareDialog } from "#features/sharing/react/share-dialog.tsx";
import {
  ApiFailure,
  createFakeApi,
  fileEntry,
  fireEvent,
  mount,
  screen,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

const ROOT_FILE = fileEntry({ id: "file_1", name: "a.pdf" });
const NESTED_FILE = fileEntry({ id: "file_1", name: "a.pdf", parentId: "folder_1" });

const LINK = {
  id: "share_1",
  itemId: ROOT_FILE.id,
  role: "viewer",
  recipientId: null,
  public: true,
  expiresAt: null,
  passwordProtected: false,
  revokedAt: null,
  url: null,
} as const;

function renderDialog(api: ReturnType<typeof createFakeApi>, entry = ROOT_FILE) {
  return mount(<ShareDialog entry={entry} open onOpenChange={() => {}} />, api);
}

describe("what the dialog claims about access", () => {
  test("never promises that only listed people can open an item", async () => {
    renderDialog(createFakeApi({ "shares.list": () => ({ items: [] }) }));

    expect(await screen.findByText(/No public links on this item/)).toBeTruthy();
    expect(screen.queryByText(/Only the people above/)).toBeNull();
  });

  test("says a parent folder's sharing still applies to a nested item", async () => {
    renderDialog(createFakeApi({ "shares.list": () => ({ items: [] }) }), NESTED_FILE);

    expect(await screen.findByText(/Access shared on a parent folder still applies/)).toBeTruthy();
  });
});

describe("adding a person", () => {
  const PERSON = { ...LINK, public: false, recipientId: "user_2" };

  function recipientField() {
    return screen.findByRole<HTMLInputElement>("textbox", { name: "Account ID" });
  }

  test("a failed add keeps what was typed, even after an earlier success", async () => {
    const api = createFakeApi({
      "shares.list": () => ({ items: [] }),
      "shares.create": () => PERSON,
    });

    renderDialog(api);

    fireEvent.change(await recipientField(), { target: { value: "user_2" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    await waitFor(async () => expect((await recipientField()).value).toBe(""));

    api.handlers["shares.create"] = () => {
      throw new ApiFailure("resource.conflict");
    };

    const field = await recipientField();

    fireEvent.change(field, { target: { value: "user_3_with_a_typo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    expect(await screen.findByText("That couldn’t be applied")).toBeTruthy();
    expect((await recipientField()).value).toBe("user_3_with_a_typo");
    expect(await recipientField()).toBe(field);
  });

  test("the next person starts at Viewer after a success", async () => {
    renderDialog(
      createFakeApi({
        "shares.list": () => ({ items: [] }),
        "shares.create": () => ({ ...PERSON, role: "editor" }),
      }),
    );

    fireEvent.change(await recipientField(), { target: { value: "user_2" } });
    await chooseRole("Role for this person", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Add" }));

    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Role for this person" }).textContent).toContain(
        "Viewer",
      ),
    );
  });
});

/** Base UI commits a mouse selection only for a press that started on the option. */
async function chooseRole(label: string, role: string) {
  fireEvent.click(screen.getByRole("combobox", { name: label }));

  const option = await screen.findByRole("option", { name: new RegExp(role) });

  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.click(option);

  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: label }).textContent).toContain(role),
  );
}

describe("a link's one-time URL", () => {
  async function createLink() {
    // Composing replaces the header's button, so the second press is the form's own submit.
    fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));

    return screen.findByRole<HTMLInputElement>("textbox", { name: "Public link" });
  }

  test("survives a failed list refresh, beside a notice about the stale list", async () => {
    const api = createFakeApi({
      "shares.list": () => ({ items: [] }),
      "shares.create": () => {
        api.handlers["shares.list"] = () => {
          throw new ApiFailure("service.unavailable");
        };

        return { ...LINK, url: "/share/secret_token" };
      },
    });

    renderDialog(api);
    const field = await createLink();

    expect(field.value).toBe("http://hyori.test/share/secret_token");
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Public link" }).value).toBe(
      "http://hyori.test/share/secret_token",
    );
  });

  test("survives a second create that fails", async () => {
    const api = createFakeApi({
      "shares.list": () => ({ items: [] }),
      "shares.create": () => ({ ...LINK, url: "/share/first_token" }),
    });

    renderDialog(api);
    await createLink();

    api.handlers["shares.create"] = () => {
      throw new ApiFailure("service.unavailable");
    };

    await createLink();
    await screen.findByText("Hyori can’t reach its services");

    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Public link" }).value).toBe(
      "http://hyori.test/share/first_token",
    );
  });

  test("ends when the dialog closes", async () => {
    const api = createFakeApi({
      "shares.list": () => ({ items: [] }),
      "shares.create": () => ({ ...LINK, url: "/share/secret_token" }),
    });

    const view = renderDialog(api);

    await createLink();
    view.rerender(<ShareDialog entry={ROOT_FILE} open={false} onOpenChange={() => {}} />);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    view.rerender(<ShareDialog entry={ROOT_FILE} open onOpenChange={() => {}} />);
    await screen.findByRole("dialog");

    expect(screen.queryByRole("textbox", { name: "Public link" })).toBeNull();
  });

  test("goes away only once that link is revoked", async () => {
    const api = createFakeApi({
      "shares.list": () => ({ items: [] }),
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
    await createLink();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    fireEvent.click(await screen.findByRole("button", { name: "Revoke link" }));

    await waitFor(() => expect(screen.queryByRole("textbox", { name: "Public link" })).toBeNull());
  });
});

describe("the composer's role", () => {
  async function openComposer() {
    fireEvent.click(await screen.findByRole("button", { name: "Create link" }));
  }

  function roleField() {
    return screen.getByRole("combobox", { name: /Anyone with the link can/ });
  }

  test("goes back to Viewer after a link is created", async () => {
    renderDialog(
      createFakeApi({
        "shares.list": () => ({ items: [] }),
        "shares.create": () => ({ ...LINK, role: "editor", url: "/share/secret_token" }),
      }),
    );

    await openComposer();
    await chooseRole("Anyone with the link can", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Create link" }));
    await screen.findByRole("textbox", { name: "Public link" });
    await openComposer();

    expect(roleField().textContent).toContain("Viewer");
  });

  test("goes back to Viewer after Cancel", async () => {
    renderDialog(createFakeApi({ "shares.list": () => ({ items: [] }) }));

    await openComposer();
    await chooseRole("Anyone with the link can", "Editor");
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openComposer();

    expect(roleField().textContent).toContain("Viewer");
  });
});

describe("revoking a link", () => {
  test("asks first, and Cancel leaves the link working", async () => {
    const api = createFakeApi({
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
    const api = createFakeApi({
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
