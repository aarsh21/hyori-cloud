import { afterEach, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { toast } from "@hyori-cloud/ui/components/sonner";
import { act, cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { systemAppearance } from "./dom-environment.ts";
import { AppearanceSurface } from "./fixtures/appearance-surface.tsx";

const STORAGE_KEY = "hyori-appearance";

async function choose(label: "Light" | "Dark" | "System") {
  fireEvent.click(within(document.body).getByRole("button", { name: "Appearance" }));
  fireEvent.click(await within(document.body).findByRole("menuitemradio", { name: label }));
  await waitFor(() => expect(within(document.body).queryByRole("menu") === null).toBe(true));
}

function expectScheme(appearance: "light" | "dark") {
  expect(document.documentElement.classList.contains(appearance)).toBe(true);
  expect(
    document.documentElement.classList.contains(appearance === "dark" ? "light" : "dark"),
  ).toBe(false);
  expect(document.documentElement.style.colorScheme).toBe(appearance);
}

afterEach(async () => {
  cleanup();
  toast.dismiss();
  localStorage.clear();
  systemAppearance.set("light");
  document.documentElement.removeAttribute("class");
  document.documentElement.removeAttribute("style");
  // next-themes removes its temporary transition-blocking style on the next timer tick.
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(systemAppearance.listenerCount).toBe(0);
});

test("system is the default; all three radio choices update the document, native controls and toasts", async () => {
  systemAppearance.set("dark");
  render(<AppearanceSurface />);
  await waitFor(() => expectScheme("dark"));
  expect(localStorage.getItem(STORAGE_KEY)).toBeNull();

  fireEvent.click(within(document.body).getByRole("button", { name: "Appearance" }));
  expect(
    (await within(document.body).findByRole("menuitemradio", { name: "System" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
  expect(document.querySelector("button button")).toBeNull();
  fireEvent.keyDown(within(document.body).getByRole("menu"), { key: "Escape" });
  await waitFor(() => expect(within(document.body).queryByRole("menu") === null).toBe(true));

  await choose("Light");
  expectScheme("light");
  expect(localStorage.getItem(STORAGE_KEY)).toBe("light");
  await act(async () => systemAppearance.set("light"));
  await act(async () => systemAppearance.set("dark"));
  expectScheme("light");

  await choose("Dark");
  expectScheme("dark");
  expect(localStorage.getItem(STORAGE_KEY)).toBe("dark");
  await act(async () => systemAppearance.set("light"));
  expectScheme("dark");

  await choose("System");
  expectScheme("light");
  expect(localStorage.getItem(STORAGE_KEY)).toBe("system");
  await act(async () => systemAppearance.set("dark"));
  expectScheme("dark");
  await act(async () => systemAppearance.set("light"));
  expectScheme("light");
});

test("an existing rich-color toast follows explicit and system appearance changes", async () => {
  render(<AppearanceSurface />);
  await act(async () => {
    toast.success("Folder created", { duration: Infinity });
  });
  await within(document.body).findByText("Folder created");

  const theme = () =>
    document.querySelector("[data-sonner-toaster]")?.getAttribute("data-sonner-theme");

  expect(theme()).toBe("light");
  await choose("Dark");
  expect(theme()).toBe("dark");
  await choose("System");
  expect(theme()).toBe("light");
  await act(async () => systemAppearance.set("dark"));
  expect(theme()).toBe("dark");
  expect(within(document.body).getByText("Folder created")).toBeTruthy();
});

test("an explicit preference survives provider remount and remains checked", async () => {
  const first = render(<AppearanceSurface />);
  await choose("Dark");
  first.unmount();
  expect(systemAppearance.listenerCount).toBe(0);
  systemAppearance.set("light");
  render(<AppearanceSurface />);
  await waitFor(() => expectScheme("dark"));
  fireEvent.click(within(document.body).getByRole("button", { name: "Appearance" }));
  expect(
    (await within(document.body).findByRole("menuitemradio", { name: "Dark" })).getAttribute(
      "aria-checked",
    ),
  ).toBe("true");
});

test("storage events synchronize another tab, including removal back to System", async () => {
  render(<AppearanceSurface />);
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: "dark" }));
  });
  expectScheme("dark");
  await act(async () => {
    window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY, newValue: null }));
  });
  expectScheme("light");
  await act(async () => systemAppearance.set("dark"));
  expectScheme("dark");
});

test("keyboard opening, selection and Escape retain accessible focus", async () => {
  render(<AppearanceSurface />);
  const trigger = within(document.body).getByRole("button", { name: "Appearance" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const dark = await within(document.body).findByRole("menuitemradio", { name: "Dark" });
  await act(async () => dark.focus());
  fireEvent.keyDown(dark, { key: "Enter" });
  await waitFor(() => expectScheme("dark"));
  await waitFor(() => expect(document.activeElement === trigger).toBe(true));
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const menu = await within(document.body).findByRole("menu");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() => expect(within(document.body).queryByRole("menu") === null).toBe(true));
  await waitFor(() => expect(document.activeElement === trigger).toBe(true));
});

for (const preference of [null, "light", "dark", "system"]) {
  test(`SSR without browser globals bootstraps ${preference ?? "default"} before hydration without a mismatch`, async () => {
    const markup = execFileSync(
      process.execPath,
      [
        "--no-env-file",
        "--no-install",
        fileURLToPath(new URL("./fixtures/appearance-ssr.tsx", import.meta.url)),
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH } },
    );

    const container = document.createElement("div");
    container.innerHTML = markup;
    document.body.append(container);
    const script = container.querySelector("script");
    expect(script).not.toBeNull();
    expect(container.firstElementChild).toBe(script);

    if (preference !== null) localStorage.setItem(STORAGE_KEY, preference);
    systemAppearance.set("dark");
    runInNewContext(script!.textContent!, { window, document, localStorage });
    const expected = preference === "light" ? "light" : "dark";
    expect(document.documentElement.classList.contains(expected)).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe(expected);
    const failures: unknown[] = [];
    const consoleErrors = spyOn(console, "error").mockImplementation(() => {});

    const root = hydrateRoot(container, <AppearanceSurface />, {
      onRecoverableError(error) {
        failures.push(error);
      },
    });

    try {
      await act(async () => {});
      await waitFor(() => expectScheme(expected));
      expect(failures).toEqual([]);
      expect(consoleErrors).not.toHaveBeenCalled();
    } finally {
      await act(async () => root.unmount());
      consoleErrors.mockRestore();
      container.remove();
    }
  });
}
