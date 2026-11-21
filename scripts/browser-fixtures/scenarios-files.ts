import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import { rowMenu, uploadFiles, uploadsTray } from "./page-actions.ts";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";

function focusedLabel(page: Page) {
  return page.evaluate(() => {
    const element = document.activeElement;

    return element?.getAttribute("aria-label") ?? element?.textContent?.trim() ?? null;
  });
}

async function browsing(run: CoreRun) {
  const { report, media } = run;
  const { context, page } = await ownerPage(run);

  await report.check("a folder can be created, and opened through its link", async () => {
    await page.getByRole("button", { name: "New folder" }).first().click();
    await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill("Trips");
    await page.getByRole("button", { name: "Create" }).click();
    await page.getByRole("link", { name: /^Trips/ }).click();
    await page.getByRole("heading", { name: "Trips" }).waitFor();
    assert.ok(page.url().includes("/folders/"), "the location didn't change");
  });

  await report.check("back and the breadcrumb both return to Files", async () => {
    await page.goBack();
    await page.getByRole("link", { name: /^Trips/ }).waitFor();
    await page.goForward();
    await page.getByRole("heading", { name: "Trips" }).waitFor();
    await page.getByRole("link", { name: "Files" }).first().click();
    await page.getByRole("link", { name: /^Trips/ }).waitFor();
  });

  await report.check("uploading through the real file picker lists the file", async () => {
    await uploadFiles(page, [media.bytes("kyoto notes.txt", 1200), media.bytes("osaka.bin", 2000)]);
    await page.getByRole("button", { name: /^kyoto notes\.txt/ }).waitFor();
    await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
    await uploadsTray(page).getByRole("button", { name: "Clear" }).click();
    await uploadsTray(page).waitFor({ state: "detached" });
  });

  await report.check("search narrows by name, and says when nothing matches", async () => {
    const search = page.getByRole("searchbox");

    await search.fill("kyoto");
    await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor({ state: "detached" });
    await page.getByRole("button", { name: /^kyoto notes\.txt/ }).waitFor();
    await search.fill("nothing like this");
    await page.getByText("No matches for “nothing like this”").waitFor();
    await page
      .getByRole("button", { name: "Clear search" })
      .filter({ hasText: "Clear search" })
      .click();
    await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
    assert.deepEqual(await search.inputValue(), "", "search box after clearing");
  });

  await report.check("the filter bar opens, filters, and reports what's active", async () => {
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("combobox", { name: "Size" }).click();
    await page.getByRole("option", { name: "Under 10 MB" }).click();
    await page.getByRole("button", { name: "Filters, 1 active" }).waitFor();
    await page.getByRole("button", { name: "Clear", exact: true }).click();
    await page.getByRole("button", { name: "Filters", exact: true }).click();
  });

  await report.check("single-key shortcuts open search and do nothing while typing", async () => {
    await page.getByRole("heading", { name: "Files" }).click();
    await page.keyboard.press("/");
    await page.waitForFunction(() => document.activeElement?.getAttribute("type") === "search");
    await page.keyboard.type("n");
    await page.getByRole("dialog").waitFor({ state: "detached", timeout: 500 });
    await page.getByRole("searchbox").fill("");
  });

  await context.close();
}

async function layoutAndAppearance(run: CoreRun) {
  const { report } = run;
  const { context, page } = await ownerPage(run, { colorScheme: "light" });

  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));

  const grid = page.getByRole("button", { name: "Grid" });

  await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
  await report.shot(page, "files-desktop-light");

  await report.check(
    "the grid choice survives leaving and reloading, without hydration errors",
    async () => {
      await grid.click();
      await page.getByRole("link", { name: "Trash" }).first().click();
      await page.getByText("Trash is empty").waitFor();
      await page.getByRole("link", { name: "Files" }).first().click();
      await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
      assert.deepEqual(await grid.getAttribute("aria-pressed"), "true", "grid after leaving");

      const before = report.consoleProblems.length;

      await page.reload();
      await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
      assert.deepEqual(await grid.getAttribute("aria-pressed"), "true", "grid after reload");

      const problems = report.consoleProblems.slice(before);

      assert.ok(
        !problems.some((problem) => /hydrat|did not match/i.test(problem)),
        `hydration problem: ${problems.join(" | ")}`,
      );
    },
  );

  await report.shot(page, "files-grid-desktop-light");

  await report.check("System follows the device, live", async () => {
    assert.deepEqual(await isDark(), false, "light device");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await report.shot(page, "files-grid-desktop-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
  });

  const chooseAppearance = async (name: string) => {
    await page.getByRole("button", { name: /Noor Haddad/ }).click();
    await page.getByRole("menuitemradio", { name }).click();
    await page.keyboard.press("Escape");
  };

  await report.check("an explicit Dark is remembered, from before the first paint", async () => {
    await chooseAppearance("Dark");
    await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
    await page.reload({ waitUntil: "commit" });
    await page.waitForFunction(() => document.documentElement !== null);
    await page.waitForLoadState("domcontentloaded");
    assert.deepEqual(await isDark(), true, "dark before hydration finished");
  });

  await report.check("the bar's own button is a stable toggle in both layouts", async () => {
    await page.getByRole("button", { name: "List" }).click();
    await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
    assert.deepEqual(
      await page.getByRole("button", { name: "List" }).getAttribute("aria-pressed"),
      "true",
      "list pressed",
    );
  });

  await report.shot(page, "files-desktop-dark");

  await report.check("Light and System can be chosen again", async () => {
    await chooseAppearance("Light");
    await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
    await chooseAppearance("System");
  });

  await context.close();
}

async function keyboard(run: CoreRun) {
  const { report } = run;
  const { context, page } = await ownerPage(run);

  await page.getByRole("link", { name: /^Trips/ }).waitFor();

  await report.check("arrow keys move through rows with one Tab stop", async () => {
    const rows = page.locator("[data-item-target]");

    await rows.first().focus();

    const start = await focusedLabel(page);

    await page.keyboard.press("ArrowDown");
    assert.notEqual(await focusedLabel(page), start, "ArrowDown didn't move");
    await page.keyboard.press("Home");
    assert.equal(await focusedLabel(page), start, "Home didn't return");
    assert.equal(await page.locator('[data-item-target][tabindex="0"]').count(), 1, "Tab stops");
  });

  await report.check("keyboard focus draws a full ring around the row, unclipped", async () => {
    await page.keyboard.press("ArrowDown");

    const ring = await page.evaluate(() => {
      const element = document.activeElement;

      if (element === null) return { shadow: "", width: 0, rowWidth: 0 };

      const overlay = getComputedStyle(element, "::after");

      return {
        shadow: overlay.boxShadow,
        width: parseFloat(overlay.width),
        rowWidth: element.closest("[data-item-key]")?.getBoundingClientRect().width ?? 0,
      };
    });

    assert.ok(ring.shadow !== "none" && ring.shadow !== "", `no focus ring: ${ring.shadow}`);
    assert.ok(Math.abs(ring.width - ring.rowWidth) < 2, `ring ${ring.width} of ${ring.rowWidth}`);
  });

  await report.shot(page, "files-keyboard-focus");

  await report.check("Shift+F10 opens the row's menu, and Escape returns focus", async () => {
    await page.keyboard.press("Shift+F10");
    await page.getByRole("menuitem", { name: "Share…" }).waitFor();
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement !== document.body);
  });

  await report.check("F2 renames, keeping the extension out of the selection", async () => {
    await page.getByRole("button", { name: /^kyoto notes\.txt/ }).focus();
    await page.keyboard.press("F2");

    const field = page.getByRole("dialog").getByLabel("Name", { exact: true });

    await field.waitFor();

    const deadline = Date.now() + 3000;
    let selected = "";

    while (Date.now() < deadline) {
      selected = await field.evaluate((element) =>
        element instanceof HTMLInputElement
          ? element.value.slice(element.selectionStart ?? 0, element.selectionEnd ?? 0)
          : "",
      );

      if (selected === "kyoto notes") break;

      await page.waitForTimeout(50);
    }

    assert.deepEqual(selected, "kyoto notes", `last selected text: ${JSON.stringify(selected)}`);
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.waitForFunction(() => document.activeElement !== document.body);
  });

  await report.check("Delete moves to Trash, with Undo offered", async () => {
    await page.getByRole("button", { name: /^osaka\.bin/ }).focus();
    await page.keyboard.press("Delete");
    await page.getByText("Moved “osaka.bin” to Trash").waitFor();
    await page.getByRole("button", { name: "Undo" }).click();
    await page.getByRole("button", { name: /^osaka\.bin/ }).waitFor();
  });

  await context.close();
}

async function trash(run: CoreRun) {
  const { report, front } = run;
  const { context, page } = await ownerPage(run);

  for (const name of ["kyoto notes.txt", "osaka.bin"]) {
    await rowMenu(page, name, /Move to Trash/);
    await page
      .getByRole("button", { name: new RegExp(`^${name.replace(".", "\\.")}`) })
      .waitFor({ state: "detached" });
  }

  await page.getByRole("link", { name: "Trash" }).first().click();

  const restoreButtons = page.getByRole("button", { name: "Restore" });

  await restoreButtons.first().waitFor();
  await report.shot(page, "trash-desktop");

  await report.check("a stray tap in a row restores nothing", async () => {
    const restored = () =>
      front.records.filter((record) => record.operation === "files.restore").length;

    const before = restored();
    const row = page.locator('[data-slot="item-table-row"]').filter({ hasText: "kyoto notes.txt" });
    const box = await row.boundingBox();

    assert.ok(box !== null, "no row to tap");

    if (box !== null) await page.mouse.click(box.x + box.width * 0.3, box.y + box.height / 2);
    await page.waitForTimeout(400);
    assert.deepEqual(restored(), before, "restores after a stray tap");
  });

  await report.check("restoring moves focus to the row that takes its place", async () => {
    await restoreButtons.first().focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => document.querySelectorAll('[data-slot="item-table-row"]').length === 1,
    );
    // The button reserves both labels' width, so its text holds "Restore" and "Restoring…".
    await page.waitForFunction(() => document.activeElement?.textContent?.startsWith("Restore"));
  });

  await report.check("the last restore leaves a real empty state", async () => {
    await page.keyboard.press("Enter");
    await page.getByText("Trash is empty").waitFor();
  });

  await context.close();
}

export async function runFileScenarios(run: CoreRun) {
  await run.report.scenario("Files: browsing", () => browsing(run));
  await run.report.scenario("Layout and appearance", () => layoutAndAppearance(run));
  await run.report.scenario("Keyboard", () => keyboard(run));
  await run.report.scenario("Trash", () => trash(run));
}
