import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { Page } from "playwright-core";

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
  await page.getByRole("button", { name: label, exact: true }).click();
  const menu = page.getByRole("menu", { name: label, exact: true });
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await menu.waitFor({ state: "hidden" });
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
