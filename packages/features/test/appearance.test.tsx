import { expect } from "bun:test";
import { CloudScreen } from "#features/cloud/react/cloud-screen.tsx";
import {
  createFakeApi,
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

async function selectDark() {
  fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
  fireEvent.click(await screen.findByRole("menuitemradio", { name: "Dark" }));
  await waitFor(() => expect(document.documentElement.classList.contains("dark")).toBe(true));
  expect(localStorage.getItem("hyori-appearance")).toBe("dark");
  expect(document.querySelector("button button") === null).toBe(true);
}

for (const initialized of [true, false]) {
  test(`appearance works on ${initialized ? "sign-in" : "setup"} without submitting or losing the form`, async () => {
    const api = createFakeApi({ "auth.status": () => ({ initialized, user: null }) });
    mount(<CloudScreen path="/" onNavigate={() => {}} />, api);
    const email = await screen.findByRole<HTMLInputElement>("textbox", { name: "Email" });
    fireEvent.change(email, { target: { value: "draft@example.test" } });

    await selectDark();
    expect(screen.getByRole<HTMLInputElement>("textbox", { name: "Email" }).value).toBe(
      "draft@example.test",
    );
    expect(api.calls.map((call) => call.operation)).toEqual(["auth.status"]);
  });
}

test("appearance is available on invites without accepting the invitation", async () => {
  const api = createFakeApi({});
  mount(<CloudScreen path="/invite/example" onNavigate={() => {}} />, api);
  await selectDark();
  expect(api.calls).toHaveLength(0);
});

for (const kind of ["file", "folder"] as const) {
  test(`public ${kind} links retain appearance through password entry and opened content`, async () => {
    const item =
      kind === "folder"
        ? folderEntry({ id: "shared_1", name: "Trip", access: VIEWER_ACCESS })
        : fileEntry({ id: "shared_1", name: "map.png", access: VIEWER_ACCESS });

    const share = {
      id: "share_1",
      itemId: item.id,
      role: "viewer",
      recipientId: null,
      public: true,
      expiresAt: null,
      passwordProtected: true,
      revokedAt: null,
      url: null,
    } as const;

    const api = createFakeApi({
      "shares.resolve": () => ({ share, item: null, requiresPassword: true }),
      "shares.unlock": () => ({ share, item, requiresPassword: false }),
      "files.list": () => fileList([], item, [{ id: item.id, name: item.name }]),
    });

    mount(<CloudScreen path="/share/example" onNavigate={() => {}} />, api);
    await selectDark();
    expect(api.calls).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Open shared item" }));
    const password = await screen.findByLabelText("Password");
    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    fireEvent.change(password, { target: { value: "example-password" } });
    fireEvent.click(screen.getByRole("button", { name: "Unlock" }));

    if (kind === "file") await screen.findByRole("heading", { name: item.name });
    else await screen.findByText("This folder is empty");

    expect(screen.getByRole("button", { name: "Appearance" })).toBeTruthy();
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(api.callsTo("shares.unlock")).toHaveLength(1);
  });
}
