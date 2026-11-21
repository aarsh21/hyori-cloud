import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Locator, Page } from "playwright-core";

/** How a journey presses a control: a click, a tap, or focus and Enter. */
type Activate = (control: Locator) => Promise<void>;

const click: Activate = (control) => control.click();

/**
 * On touch, the row, Files and Account menus open as bottom sheets: a dialog of buttons named like
 * the menu. Pointers keep menus. Journeys name the surface and reach it either way.
 */
export function menuSurface(page: Page, name?: string) {
  const named = name === undefined ? {} : { name, exact: true };

  return page.getByRole("menu", named).or(page.getByRole("dialog", named));
}

/**
 * On touch, the server renders these menus' triggers as menu buttons and the client swaps in sheet
 * triggers just after hydration. Focus on the old button is lost with it, so journeys take the sheet
 * trigger. Pointers have no swap.
 */
export async function sheetTrigger(page: Page, trigger: Locator) {
  if (await page.evaluate(() => matchMedia("(pointer: coarse)").matches))
    await trigger.and(page.locator('[aria-haspopup="dialog"]')).first().waitFor();

  return trigger;
}

/** A choice in the open menu or sheet: a menu item, a radio or checkbox item, or a sheet's button. */
export function menuChoice(page: Page, name: string | RegExp, surface?: string) {
  const options = { name, exact: !(name instanceof RegExp) };
  const within = surface === undefined ? {} : { name: surface, exact: true };
  const menu = page.getByRole("menu", within);
  const sheet = page.getByRole("dialog", within);

  return menu
    .getByRole("menuitem", options)
    .or(menu.getByRole("menuitemradio", options))
    .or(menu.getByRole("menuitemcheckbox", options))
    .or(sheet.getByRole("button", options));
}

/**
 * Files' bar shows New folder, Filters and the layout on wide screens; phones fold them into
 * "More options" so the bar keeps one row. Journeys name the action and reach it either way.
 */
export async function filesBarAction(
  page: Page,
  name: "New folder" | "Filters" | "List" | "Grid",
  activate: Activate = click,
) {
  const inBar = page.getByRole("button", { name, exact: true }).filter({ visible: true }).first();
  const more = page.getByRole("button", { name: /^More options/ }).filter({ visible: true });
  await inBar.or(more).first().waitFor();

  if (await inBar.isVisible()) return activate(inBar);

  await activate(await sheetTrigger(page, more));
  await activate(menuChoice(page, new RegExp(`^${name}`)));
}

/** The listing's search field; phones open it from the bar's Search button first. */
export async function filesSearch(page: Page, activate: Activate = click) {
  const field = page.getByRole("searchbox").filter({ visible: true });
  const open = page.getByRole("button", { name: /^Search / }).filter({ visible: true });
  await field.or(open).first().waitFor();

  if (!(await field.isVisible())) await activate(open);

  return field;
}

/** Trash is a sidebar link on wide screens and an item in the Account sheet on phones. */
export async function openTrash(page: Page, activate: Activate = click) {
  const visible = { visible: true };
  const link = page.getByRole("link", { name: "Trash", exact: true }).filter(visible);
  const account = page.getByRole("button", { name: "Account", exact: true }).filter(visible);
  await link.or(account).first().waitFor();

  if (await link.first().isVisible()) return activate(link.first());

  await activate(await sheetTrigger(page, account));
  await activate(menuChoice(page, "Trash", "Account"));
}

export async function setupAdmin(
  page: Page,
  { token, email, password }: { token: string; email: string; password: string },
) {
  await page.getByLabel("Setup token").fill(token);
  await page.getByLabel("Name", { exact: true }).fill("Noor Haddad");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Create admin account" }).click();
}

export async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function chooseWith(
  page: Page,
  trigger: () => Promise<void>,
  files: string | string[],
) {
  const chooser = page.waitForEvent("filechooser", { timeout: 10_000 });

  await trigger();
  await (await chooser).setFiles(files);
}

export async function uploadFiles(page: Page, files: string | string[]) {
  await chooseWith(
    page,
    () => page.getByRole("button", { name: "Upload", exact: true }).click(),
    files,
  );
}

export function uploadsTray(page: Page) {
  return page.getByRole("region", { name: "Uploads" });
}

export async function rowMenu(page: Page, name: string, item: RegExp | string) {
  const label = `Actions for ${name}`;
  await (await sheetTrigger(page, page.getByRole("button", { name: label, exact: true }))).click();
  await menuChoice(page, item, label).click();
  await menuSurface(page, label).waitFor({ state: "hidden" });
}

/** A real click and a real browser download, exactly as it landed. */
export async function downloadBytes(page: Page, trigger: () => Promise<void>) {
  // Together, so a trigger that fails doesn't leave this wait to time out with nothing listening.
  const [download] = await Promise.all([
    page.waitForEvent("download", { timeout: 30_000 }),
    trigger(),
  ]);

  return readFileSync(await download.path());
}

/** The same, hashed. */
export async function downloadHash(page: Page, trigger: () => Promise<void>) {
  return createHash("sha256")
    .update(await downloadBytes(page, trigger))
    .digest("hex");
}

/**
 * Fetched by the browser itself, so with its certificate trust and this page's cookies. Playwright's
 * own request client is outside Chromium, and would need TLS checks turned off to reach this host.
 */
export function fetchInPage(page: Page, url: string) {
  return page.evaluate(async (target) => {
    const response = await fetch(target, { cache: "no-store" });
    const bytes = await response.clone().arrayBuffer();
    const digest = await crypto.subtle.digest("SHA-256", bytes);

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      // Bundles are read by digest. Only documents are worth carrying back as text.
      text: bytes.byteLength > 4_000_000 ? "" : await response.text(),
      sha256: [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join(""),
    };
  }, url);
}

/**
 * The server-rendered button is replaced by the real menu at hydration, so this says the page is live.
 * Clicking a server-rendered control before then does nothing, as it would for a very fast person.
 */
export async function hydrated(page: Page) {
  await page.getByRole("button", { name: "Appearance", expanded: false }).waitFor();
}
