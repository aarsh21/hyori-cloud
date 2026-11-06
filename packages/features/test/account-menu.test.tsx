import { afterEach, describe, expect } from "bun:test";
import { copyText } from "@hyori-cloud/ui/lib/browser";
import { readSingleKeyShortcuts } from "@hyori-cloud/ui/lib/single-key-shortcuts";
import { CurrentUserProvider } from "#features/auth/react/current-user.tsx";
import { AccountMenu } from "#features/cloud/react/account-menu.tsx";
import { CloudNavigationProvider } from "#features/cloud/react/cloud-navigation.tsx";
import {
  ApiFailure,
  createFakeApi,
  fireEvent,
  mount,
  screen,
  SIGNED_IN_USER,
  test,
  waitFor,
} from "#features-test/mounted.tsx";

function AccountSurface() {
  return (
    <CloudNavigationProvider location={{ section: "files", folderId: null }} onNavigate={() => {}}>
      <CurrentUserProvider value={SIGNED_IN_USER}>
        <AccountMenu />
      </CurrentUserProvider>
    </CloudNavigationProvider>
  );
}

async function openAccountMenu() {
  fireEvent.click(screen.getByRole("button", { name: /Ada/ }));

  return screen.findByRole("menu");
}

afterEach(() => {
  Reflect.deleteProperty(navigator, "clipboard");
});

describe("account ID", () => {
  test("copying rejects instead of throwing when the clipboard API doesn't exist", async () => {
    expect(navigator.clipboard).toBeUndefined();

    const attempt = copyText("user_1");

    expect(attempt).toBeInstanceOf(Promise);
    await expect(attempt).rejects.toBeInstanceOf(TypeError);
  });

  test("stays readable and reports failure when the clipboard API doesn't exist (plain HTTP)", async () => {
    expect(navigator.clipboard).toBeUndefined();
    mount(<AccountSurface />, createFakeApi({}));

    await openAccountMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Your account ID" }));

    const field = await screen.findByRole<HTMLInputElement>("textbox", { name: "Account ID" });
    expect(field.value).toBe(SIGNED_IN_USER.id);

    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));

    expect(await screen.findByText("Can’t copy")).toBeTruthy();
    expect(field.value).toBe(SIGNED_IN_USER.id);
  });

  test("copies the literal ID, not a URL resolved from it", async () => {
    const written: string[] = [];

    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: async (text: string) => void written.push(text) },
    });
    mount(<AccountSurface />, createFakeApi({}));

    await openAccountMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Your account ID" }));
    await screen.findByRole("textbox", { name: "Account ID" });
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));

    await waitFor(() => expect(written).toEqual([SIGNED_IN_USER.id]));
  });
});

describe("sign out", () => {
  test("a failure outlives the closed menu and can be retried", async () => {
    const api = createFakeApi({
      "auth.logout": () => {
        throw new ApiFailure("service.unavailable");
      },
    });

    mount(<AccountSurface />, api);

    await openAccountMenu();
    fireEvent.click(await screen.findByRole("menuitem", { name: "Sign out" }));

    expect(await screen.findByText("You’re still signed in")).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    expect(api.callsTo("auth.logout")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(api.callsTo("auth.logout")).toHaveLength(2));
  });
});

describe("single-key shortcuts", () => {
  test("can be turned off, and stay off for this browser", async () => {
    mount(<AccountSurface />, createFakeApi({}));

    await openAccountMenu();

    const setting = await screen.findByRole("menuitemcheckbox", { name: "Single-key shortcuts" });

    expect(setting.getAttribute("aria-checked")).toBe("true");
    expect(readSingleKeyShortcuts()).toBe(true);

    fireEvent.click(setting);

    await waitFor(() => expect(setting.getAttribute("aria-checked")).toBe("false"));
    expect(readSingleKeyShortcuts()).toBe(false);
  });
});
