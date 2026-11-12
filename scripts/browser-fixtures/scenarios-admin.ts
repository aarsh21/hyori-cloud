import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Page } from "playwright-core";
import { signIn, uploadFiles, uploadsTray } from "./page-actions.ts";
import { freshContext, openPage, ownerPage, waitForHydration } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";

export const accountPassword = () => `fixture ${randomBytes(12).toString("hex")} words`;

/** Through the visible admin dialog, as an admin would. */
export async function addUser(page: Page, name: string, email: string, password: string) {
  await page.getByRole("button", { name: "Add user" }).click();

  const dialog = page.getByRole("dialog");

  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Email").fill(email);
  await dialog.getByLabel("Password", { exact: true }).fill(password);
  await dialog.getByRole("button", { name: "Add user" }).click();
  await dialog.waitFor({ state: "detached" });
  await page.locator('[data-slot="item-table-row"]').filter({ hasText: email }).waitFor();
}

export async function openUsers(page: Page) {
  await waitForHydration(page);

  if (await page.getByRole("button", { name: "Account", exact: true }).isVisible()) {
    await page.getByRole("button", { name: "Account", exact: true }).press("Enter");
    await page.getByRole("menuitem", { name: "Users", exact: true }).press("Enter");
  } else {
    await page.getByRole("link", { name: "Users" }).first().click();
  }

  await page.getByRole("heading", { name: "Users" }).waitFor();
}

async function administration(run: CoreRun) {
  const { report, media } = run;
  const { context, page } = await ownerPage(run);

  await openUsers(page);
  await report.shot(page, "admin-users-desktop");

  await report.check("the admin page states the privacy boundary", () =>
    page
      .getByText("Admins see storage totals only. They can’t browse other people’s files.")
      .waitFor(),
  );

  const email = "imran@example.test";
  const password = accountPassword();

  await report.check("an admin can add a user", () =>
    addUser(page, "Imran Qureshi", email, password),
  );

  const memberId = run.stack.sql(`SELECT id FROM hyori_users WHERE email='${email}'`);

  const memberContext = await freshContext(run);
  const member = await openPage(run, memberContext);

  await signIn(member, email, password);
  await member.getByText("No files yet").waitFor();

  await report.check("someone who isn't an admin has no Users page", async () => {
    assert.equal(await member.getByRole("link", { name: "Users" }).count(), 0, "Users links");
    await member.goto(`${run.origin}/admin`);
    await member.getByText("Admins only").waitFor();
    await member.getByRole("link", { name: "Files" }).first().click();
  });

  const setQuota = async (gigabytes: string) => {
    await page.getByRole("button", { name: "Actions for Imran Qureshi" }).click();
    await page.getByRole("menuitem", { name: /Set storage quota/ }).click();

    const dialog = page.getByRole("dialog");

    await dialog.getByLabel("Quota in GB").fill(gigabytes);
    await dialog.getByRole("button", { name: "Save" }).click();
    await dialog.waitFor({ state: "detached" });
  };

  await report.check(
    "a lowered quota refuses the upload, in plain words, in the tray",
    async () => {
      await setQuota("0.001");
      await uploadFiles(member, media.bytes("over quota.bin", 4 * 1024 * 1024));
      await uploadsTray(member)
        .getByText(/Free up space or ask your admin/)
        .waitFor({ timeout: 30_000 });
      await report.shot(member, "quota-refused-tray");
      await uploadsTray(member)
        .getByRole("button", { name: "Cancel upload of over quota.bin" })
        .click();
      await uploadsTray(member).getByRole("button", { name: "Remove over quota.bin" }).click();
    },
  );

  await report.check(
    "raising it lets the same person upload, and totals update for the admin",
    async () => {
      await setQuota("1");
      await uploadFiles(member, media.bytes("kept by member.bin", 2 * 1024 * 1024));
      await uploadsTray(member).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
      await page.reload();
      await page
        .locator('[data-slot="item-table-row"]')
        .filter({ hasText: /2 MB of 1 GB used/ })
        .waitFor();
    },
  );

  await report.check("deleting needs the exact email, and names what goes", async () => {
    await page.getByRole("button", { name: "Actions for Imran Qureshi" }).click();
    await page.getByRole("menuitem", { name: /Delete account and files/ }).click();

    const dialog = page.getByRole("alertdialog");
    const confirm = dialog.getByRole("button", { name: "Delete account and files" });

    await dialog.getByText("Delete Imran Qureshi’s account and files?").waitFor();
    assert.equal(await confirm.isDisabled(), true, "confirm before typing");
    await dialog.getByLabel(/to confirm/).fill("not the email");
    assert.equal(await confirm.isDisabled(), true, "confirm with the wrong email");
    await report.shot(page, "admin-delete-confirm");
    await dialog.getByLabel(/to confirm/).fill(email);
    await page.keyboard.press("Enter");
    await dialog.waitFor({ state: "detached" });
  });

  await report.check("the deleted account shows its state, then leaves the list", async () => {
    await page.reload();
    await page
      .waitForFunction((address) => !document.body.innerText.includes(address), email, {
        timeout: 60_000,
        polling: 1000,
      })
      .catch(async () => {
        await report.shot(page, "admin-delete-still-listed");
        throw new Error("the account was still listed after a minute");
      });
  });

  await report.check("the deleted person's open session ends at their next request", async () => {
    await member.reload();
    await member.getByRole("heading", { name: "Sign in" }).waitFor();
  });

  await report.check("account purge removes its file, version and object metadata", () => {
    assert.notEqual(memberId, "");

    const remaining = run.stack.sql(`SELECT
      (SELECT count(*) FROM hyori_items WHERE owner_id='${memberId}') +
      (SELECT count(*) FROM hyori_versions WHERE owner_id='${memberId}') +
      (SELECT count(*) FROM hyori_objects WHERE owner_id='${memberId}')`);

    assert.equal(remaining, "0");
  });

  await report.check(
    "an invite link creates an account without an admin choosing a password",
    async () => {
      await page.getByRole("button", { name: "Invite" }).click();

      const dialog = page.getByRole("dialog");

      await dialog.getByRole("button", { name: "Create invite link" }).click();

      const url = await dialog.getByRole("textbox", { name: "Invite link" }).inputValue();

      await report.shot(page, "admin-invite-link");
      await dialog.getByRole("button", { name: "Done" }).click();

      const guestContext = await freshContext(run);
      const guest = await openPage(run, guestContext, new URL(url).pathname);

      await guest.getByRole("heading", { name: "Create your account" }).waitFor();
      await guest.getByLabel("Name", { exact: true }).fill("Ines Duarte");
      await guest.getByLabel("Email").fill(`ines-${randomBytes(6).toString("hex")}@example.test`);
      await guest.getByLabel("Password", { exact: true }).fill(accountPassword());
      await guest.getByRole("button", { name: "Create account" }).click();
      await guest.getByText("No files yet").waitFor();
      await guestContext.close();
    },
  );

  await memberContext.close();
  await context.close();
}

export async function runAdminScenarios(run: CoreRun) {
  await run.report.scenario(
    run.contextOptions?.isMobile ? "Administration (phone)" : "Administration",
    () => administration(run),
  );
}
