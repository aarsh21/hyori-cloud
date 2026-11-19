import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Locator, Page } from "playwright-core";
import { addUser, accountPassword, runAdminScenarios } from "./scenarios-admin.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { PHONE } from "./scenarios-touch.ts";
import { runReadinessPhotoScenarios } from "./scenarios-readiness-photos.ts";
import { runSortingScenarios } from "./scenarios-sorting.ts";
import {
  chooseWith,
  downloadBytes,
  hydrated,
  signIn,
  uploadFiles,
  uploadsTray,
} from "./page-actions.ts";

// Begin keyboard journeys at a named control, then use trusted keyboard events throughout.
async function enter(control: Locator) {
  await control.focus();
  await control.press("Enter");
}

// The menu this row's trigger opened, by its label: the previous row's may still be closing.
async function menu(page: Page, name: string, action: string) {
  const label = `Actions for ${name}`;
  await enter(page.getByRole("button", { name: label, exact: true }));
  await enter(
    page
      .getByRole("menu", { name: label, exact: true })
      .getByRole("menuitem", { name: new RegExp(`^${action}`) }),
  );
}

async function folder(page: Page, name: string) {
  await enter(page.getByRole("button", { name: "New folder" }).first());
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Name", { exact: true }).press("Enter");
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).waitFor();
}

async function clearUploads(page: Page) {
  await uploadsTray(page).getByLabel("Uploaded").first().waitFor({ timeout: 30_000 });
  await uploadsTray(page).getByRole("button", { name: "Clear", exact: true }).click();
  await uploadsTray(page).waitFor({ state: "detached" });
}

async function lifecycle(run: CoreRun, phone: boolean) {
  const { report, media } = run;
  const size = phone ? "phone" : "desktop";
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  const source = media.bytes(`readiness-${size}.bin`, 1937);
  const name = `renamed-${size}.bin`;
  const destination = `Archive ${size}`;

  try {
    await report.check(`${size}: rename commits and download preserves bytes`, async () => {
      await uploadFiles(page, source);
      await clearUploads(page);
      await menu(page, `readiness-${size}.bin`, "Rename…");
      await page.getByRole("dialog").getByLabel("Name", { exact: true }).fill(name);
      await page.getByRole("dialog").getByLabel("Name", { exact: true }).press("Enter");
      await page.getByRole("dialog").waitFor({ state: "detached" });
      const bytes = await downloadBytes(page, () => menu(page, name, "Download"));
      assert.deepEqual(bytes, readFileSync(source));
    });
    await report.check(
      `${size}: keyboard moves a file and reload keeps its new parent`,
      async () => {
        await folder(page, destination);
        await menu(page, name, "Move…");
        const dialog = page.getByRole("dialog");
        await enter(dialog.getByRole("button", { name: destination, exact: true }));
        await enter(dialog.getByRole("button", { name: "Move here" }));
        await dialog.waitFor({ state: "detached" });
        await page
          .getByRole("button", { name: new RegExp(`^${name}`) })
          .waitFor({ state: "detached" });
        await enter(page.getByRole("link", { name: new RegExp(`^${destination}`) }));
        await page.reload();
        await page.getByRole("button", { name: new RegExp(`^${name}`) }).waitFor();
        assert.deepEqual(
          await downloadBytes(page, () => menu(page, name, "Download")),
          readFileSync(source),
        );
      },
    );
    await report.check(
      `${size}: duplicate upload never silently replaces existing bytes`,
      async () => {
        await uploadFiles(page, media.bytes(name, 5171));
        await uploadsTray(page)
          .getByText(/The server reported a conflict/)
          .waitFor({ timeout: 30_000 });
        await report.shot(page, `readiness-${size}-name-conflict`);
        assert.deepEqual(
          await downloadBytes(page, () => menu(page, name, "Download")),
          readFileSync(source),
        );
        await uploadsTray(page)
          .getByRole("button", { name: `Cancel upload of ${name}` })
          .click();
        await uploadsTray(page)
          .getByRole("button", { name: `Remove ${name}` })
          .click();
      },
    );
    await report.check(
      `${size}: version restore restores bytes and version deletion keeps current bytes`,
      async () => {
        await menu(page, name, "Upload new version…");
        const dialog = page.getByRole("dialog");
        await chooseWith(
          page,
          () => dialog.getByRole("button", { name: "Choose file…" }).click(),
          media.bytes(`revision-${size}.bin`, 8127),
        );
        await enter(dialog.getByRole("button", { name: "Upload new version", exact: true }));
        await clearUploads(page);
        await menu(page, name, "Version history…");
        await dialog.getByRole("button", { name: "Restore", exact: true }).waitFor();
        await report.shot(page, `readiness-${size}-version-history`);
        await enter(dialog.getByRole("button", { name: "Restore", exact: true }).first());
        await page.getByText(/Restored the version from/).waitFor();
        await enter(dialog.getByRole("button", { name: /^Delete version from/ }).first());
        await enter(
          page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Delete version", exact: true }),
        );
        await page.getByRole("alertdialog").waitFor({ state: "detached" });
        await enter(dialog.getByRole("button", { name: "Close", exact: true }));
        await dialog.waitFor({ state: "detached" });
        assert.deepEqual(
          await downloadBytes(page, () => menu(page, name, "Download")),
          readFileSync(source),
        );
      },
    );
    await report.check(
      `${size}: permanent deletion removes one item, empty trash removes the rest`,
      async () => {
        await uploadFiles(page, media.bytes(`discard-${size}.bin`, 631));
        await clearUploads(page);
        await menu(page, name, "Move to Trash");
        await menu(page, `discard-${size}.bin`, "Move to Trash");
        await page.getByRole("link", { name: "Trash", exact: true }).first().click();
        await enter(page.getByRole("button", { name: `More actions for ${name}`, exact: true }));
        await enter(
          page
            .getByRole("menu", { name: `More actions for ${name}`, exact: true })
            .getByRole("menuitem", { name: "Delete permanently…" }),
        );
        await report.shot(page, `readiness-${size}-permanent-delete`);
        await enter(
          page
            .getByRole("alertdialog")
            .getByRole("button", { name: "Delete permanently", exact: true }),
        );
        await page
          .getByRole("button", { name: `More actions for ${name}`, exact: true })
          .waitFor({ state: "detached" });
        await enter(page.getByRole("button", { name: "Empty Trash…" }));
        await enter(
          page.getByRole("alertdialog").getByRole("button", { name: "Empty Trash", exact: true }),
        );
        await page.getByText("Trash is empty").waitFor();
        await page.reload();
        await page.getByText("Trash is empty").waitFor();
      },
    );
  } finally {
    await context.close();
  }
}

async function accountSharing(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { report, media } = run;
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  const recipientContext = await freshContext(run, phone ? PHONE : { deviceScaleFactor: 2 });

  try {
    await page.goto(`${run.origin}/admin`);
    await page.getByRole("heading", { name: "Users", exact: true }).waitFor();
    const password = accountPassword();
    const email = `roles-${size}@example.test`;
    await addUser(page, `Aya ${size}`, email, password);
    const recipient = await openPage(run, recipientContext);
    await signIn(recipient, email, password);
    await recipient.getByText("No files yet").waitFor();
    await enter(
      recipient.getByRole("button", { name: phone ? "Account" : new RegExp(`Aya ${size}`) }),
    );
    await enter(recipient.getByRole("menuitem", { name: "Your account ID" }));
    const accountId = await recipient.getByRole("textbox", { name: "Account ID" }).inputValue();
    await enter(recipient.getByRole("dialog").getByRole("button", { name: "Done", exact: true }));
    await page.goto(run.origin);
    const folderName = `Role test ${size}`;
    await folder(page, folderName);
    await page.getByRole("link", { name: new RegExp(`^${folderName}`) }).click();
    const folderUrl = page.url();
    const ownedBytes = media.bytes(`owned-${size}.bin`, 2713);
    await uploadFiles(page, ownedBytes);
    await clearUploads(page);
    await report.check(`${size}: the Files breadcrumb returns to the root`, async () => {
      await page
        .getByRole("navigation", { name: "Folder path", exact: true })
        .getByRole("link", { name: "Files", exact: true })
        .click();
      await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
    });

    for (const role of ["Viewer", "Contributor", "Editor"] as const) {
      await report.check(
        `${size}: account ${role} acts through Shared, then loses access on removal`,
        async () => {
          await menu(page, folderName, "Share…");
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("Account ID", { exact: true }).fill(accountId);
          await enter(dialog.getByRole("combobox", { name: "Role for this person" }));
          await enter(page.getByRole("option", { name: new RegExp(`^${role}`) }));
          await enter(dialog.getByRole("button", { name: "Add", exact: true }));
          await dialog.getByRole("button", { name: "Remove", exact: true }).waitFor();
          await enter(dialog.getByRole("button", { name: "Done", exact: true }));
          await recipient.goto(`${run.origin}/shared`);
          await recipient.getByRole("link", { name: new RegExp(`^${folderName}`) }).click();
          await recipient.getByRole("button", { name: new RegExp(`^owned-${size}`) }).waitFor();
          await report.shot(recipient, `readiness-${size}-shared-${role.toLowerCase()}`);
          assert.deepEqual(
            await downloadBytes(recipient, () => menu(recipient, `owned-${size}.bin`, "Download")),
            readFileSync(ownedBytes),
          );
          assert.equal(
            await recipient.getByRole("button", { name: "Upload", exact: true }).count(),
            role === "Viewer" ? 0 : 1,
          );

          if (role !== "Viewer") {
            await uploadFiles(recipient, media.bytes(`${role}-${size}.bin`, 1429));
            await clearUploads(recipient);
            await recipient.getByRole("button", { name: new RegExp(`^${role}-${size}`) }).waitFor();
          }

          await enter(
            recipient.getByRole("button", { name: `Actions for owned-${size}.bin`, exact: true }),
          );
          assert.equal(
            await recipient.getByRole("menuitem", { name: "Upload new version…" }).count(),
            role === "Editor" ? 1 : 0,
          );
          await recipient.keyboard.press("Escape");

          if (role === "Editor") {
            const replacement = media.bytes(`editor-change-${size}.bin`, 4783);
            await menu(recipient, `owned-${size}.bin`, "Upload new version…");
            const replacementDialog = recipient.getByRole("dialog");
            await chooseWith(
              recipient,
              () => replacementDialog.getByRole("button", { name: "Choose file…" }).click(),
              replacement,
            );
            await enter(
              replacementDialog.getByRole("button", { name: "Upload new version", exact: true }),
            );
            await clearUploads(recipient);
            assert.deepEqual(
              await downloadBytes(recipient, () =>
                menu(recipient, `owned-${size}.bin`, "Download"),
              ),
              readFileSync(replacement),
            );
          }

          await menu(page, folderName, "Share…");
          await enter(dialog.getByRole("button", { name: "Remove", exact: true }));
          await dialog
            .getByRole("button", { name: "Remove", exact: true })
            .waitFor({ state: "detached" });
          await enter(dialog.getByRole("button", { name: "Done", exact: true }));
          await recipient.reload();
          await recipient
            .getByText(/You don’t have access|no longer here/)
            .first()
            .waitFor();
          await recipient.goto(`${run.origin}/shared`);
          await recipient.getByText("Nothing shared with you yet").waitFor();
          report.observe(`${size} ${role} shared folder`, folderUrl);
        },
      );
    }
  } catch (error) {
    await report.shot(page, `readiness-${size}-account-sharing-stopped`);
    throw error;
  } finally {
    await recipientContext.close();
    await context.close();
  }
}

async function links(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { report, media } = run;
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  const guestContext = await freshContext(run, phone ? PHONE : { deviceScaleFactor: 2 });

  try {
    const name = `Drop box ${size}`;
    await folder(page, name);
    await menu(page, name, "Share…");
    const dialog = page.getByRole("dialog");
    await enter(dialog.getByRole("button", { name: "Create link", exact: true }));
    await enter(dialog.getByRole("combobox", { name: /Anyone with the link can/ }));
    await enter(page.getByRole("option", { name: /^Contributor/ }));
    await dialog.getByLabel("Password (optional)", { exact: true }).fill("review share password");
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await dialog.getByLabel("Expires (optional)").fill(tomorrow);
    await enter(dialog.getByRole("button", { name: "Create link", exact: true }));
    const url = await dialog.getByRole("textbox", { name: "Public link" }).inputValue();
    await report.shot(page, `readiness-${size}-password-expiry-link`);
    await enter(dialog.getByRole("button", { name: "Done", exact: true }));
    const guest = await openPage(run, guestContext, new URL(url).pathname);
    await hydrated(guest);
    await report.check(
      `${size}: password link denies a wrong password and unlocks with the right one`,
      async () => {
        await enter(guest.getByRole("button", { name: "Open shared item" }));
        await guest.getByRole("heading", { name: "This link needs a password" }).waitFor();
        await guest.getByLabel("Password", { exact: true }).fill("wrong password");
        await enter(guest.getByRole("button", { name: "Unlock", exact: true }));
        await guest.getByRole("alert").waitFor();
        await report.shot(guest, `readiness-${size}-wrong-link-password`);
        await guest.getByLabel("Password", { exact: true }).fill("review share password");
        await enter(guest.getByRole("button", { name: "Unlock", exact: true }));
        await guest.getByRole("heading", { name, exact: true }).waitFor();
      },
    );
    await report.check(
      `${size}: anonymous contributor upload reaches the owner's folder`,
      async () => {
        await uploadFiles(guest, media.bytes(`anonymous-${size}.bin`, 6701));
        await clearUploads(guest);
        await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
        await page.getByRole("button", { name: new RegExp(`^anonymous-${size}`) }).waitFor();
      },
    );
    await report.check(
      `${size}: an unlocked link stops working when its deadline passes`,
      async () => {
        const file = `anonymous-${size}.bin`;
        const download = () => menu(guest, file, "Download");
        assert.equal((await downloadBytes(guest, download)).length, 6701);

        // The UI accepts whole dates. Shorten only this disposable link's deadline, after its
        // visitor already has a grant. Both requests use the real server clock and same cookies.
        assert.equal(
          run.stack.sql(`WITH shortened AS (
        UPDATE hyori_shares SET expires_at = now() + interval '1 second'
        WHERE public AND expires_at > now() AND item_id IN
          (SELECT id FROM hyori_items WHERE name = 'Drop box ${size}') RETURNING id
      ) SELECT count(*) FROM shortened`),
          "1",
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        await download();
        await enter(guest.getByRole("button", { name: "Open link again" }).first());
        await guest.getByRole("heading", { name: "This link no longer works" }).waitFor();
      },
    );
  } finally {
    await guestContext.close();
    await context.close();
  }
}

async function recoveryAndAlbums(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { report } = run;
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });

  try {
    await report.check(
      `${size}: name search, size filters and reset preserve the listing`,
      async () => {
        const search = page.getByRole("searchbox");

        await search.fill(`multipart-${size}`);
        await page.getByRole("button", { name: new RegExp(`^multipart-${size}`) }).waitFor();
        await search.fill("no file has this readiness name");
        await page.getByText("Nothing matches").waitFor();
        await enter(page.getByRole("button", { name: "Clear filters", exact: true }));
        await enter(page.getByRole("button", { name: "Filters", exact: true }));
        await enter(page.getByRole("combobox", { name: "Size", exact: true }));
        await enter(page.getByRole("option", { name: "Under 10 MB", exact: true }));
        await page.getByRole("button", { name: "Filters, 1 active" }).waitFor();
        await page.getByRole("button", { name: new RegExp(`^multipart-${size}`) }).waitFor();
        await enter(page.getByRole("button", { name: "Clear", exact: true }));
        await enter(page.getByRole("button", { name: "Filters", exact: true }));
        assert.equal(await search.inputValue(), "");
      },
    );
    await report.check(
      `${size}: keyboard appearance menu supports Light, Dark and live System`,
      async () => {
        const choose = async (name: string) => {
          await enter(page.getByRole("button", { name: phone ? "Account" : /Noor Haddad/ }));
          await enter(page.getByRole("menuitemradio", { name, exact: true }));
          await page.keyboard.press("Escape");
        };

        await choose("Dark");
        await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
        await page.reload();
        await page.getByRole("button", { name: new RegExp(`^multipart-${size}`) }).waitFor();
        assert.equal(
          await page.evaluate(() => document.documentElement.classList.contains("dark")),
          true,
        );
        await choose("Light");
        await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
        await choose("System");
        await page.emulateMedia({ colorScheme: "dark" });
        await page.waitForFunction(() => document.documentElement.classList.contains("dark"));
        await page.emulateMedia({ colorScheme: "light" });
        await page.waitForFunction(() => !document.documentElement.classList.contains("dark"));
      },
    );
    await report.check(
      `${size}: offline uncached navigation recovers when connectivity returns`,
      async () => {
        await context.setOffline(true);

        try {
          await page.getByRole("link", { name: "Shared", exact: true }).first().click();
          await page.getByText("You’re offline", { exact: true }).waitFor();
          assert.equal(
            await page.getByRole("navigation", { name: "Main", exact: true }).first().isVisible(),
            true,
          );
          await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
          await report.shot(page, `readiness-${size}-offline`);
        } finally {
          await context.setOffline(false);
        }

        await page.getByRole("heading", { name: "Shared with me", exact: true }).waitFor();
      },
    );
    await report.check(`${size}: reloading after connectivity returns recovers Files`, async () => {
      await page.goto(run.origin);
      await page.getByRole("button", { name: new RegExp(`^multipart-${size}`) }).waitFor();
    });
    await report.check(`${size}: album creation survives reload`, async () => {
      await page.goto(`${run.origin}/photos/albums`);
      await enter(page.getByRole("button", { name: "New album", exact: true }).first());
      const dialog = page.getByRole("dialog");
      await dialog.getByLabel("Name", { exact: true }).fill(`Memories ${size}`);
      await dialog.getByLabel("Name", { exact: true }).press("Enter");
      await dialog.waitFor({ state: "detached" });
      await page.reload();
      await page.getByRole("link", { name: new RegExp(`^Memories ${size}`) }).click();
      await page.getByText("This album is empty").waitFor();
      await report.shot(page, `readiness-${size}-album`);
    });
    await report.check(
      `${size}: an actually stopped Rust server shows failure and recovers`,
      async () => {
        await run.stack.restartServer(async () => {
          await page.getByRole("link", { name: "Trash", exact: true }).first().click();
          await page
            .getByText(/Hyori can’t reach its services|Can’t reach the server/)
            .first()
            .waitFor({ timeout: 30_000 });
          await report.shot(page, `readiness-${size}-backend-down`);
        });
        await enter(page.getByRole("button", { name: "Try again", exact: true }).first());
        await page.getByRole("heading", { name: "Trash", exact: true }).waitFor();
        await page.getByRole("alert").waitFor({ state: "detached" });
      },
    );
  } finally {
    await context.setOffline(false);
    await context.close();
  }
}

async function lockout(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  const guestContext = await freshContext(run, phone ? PHONE : { deviceScaleFactor: 2 });

  try {
    await page.goto(`${run.origin}/admin`);
    const email = `lockout-${size}@example.test`;
    const password = accountPassword();
    await addUser(page, `Lockout ${size}`, email, password);
    const guest = await openPage(run, guestContext);
    await run.report.check(
      `${size}: ten wrong passwords then the correct one show lockout`,
      async () => {
        for (let attempt = 0; attempt < 10; attempt += 1) {
          const reply = guest.waitForResponse(
            (response) =>
              response.url().endsWith("/api/rpc") &&
              response.request().postData()?.includes('"operation":"auth.login"') === true,
          );

          await signIn(guest, email, "wrong fixture password");
          await reply;
          await guest.getByText("That email and password don’t match", { exact: true }).waitFor();
        }

        await signIn(guest, email, password);
        await guest.getByText("Too many attempts", { exact: true }).waitFor();
        await run.report.shot(guest, `readiness-${size}-login-lockout`);
      },
    );
  } finally {
    await guestContext.close();
    await context.close();
  }
}

async function transfers(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { report, media, front } = run;
  const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  let release = () => {};

  try {
    const name = `multipart-${size}.bin`;
    const source = media.bytes(name, 8 * 1024 * 1024 + 1193);
    release = front.hold(
      (record) =>
        record.operation === "uploads.part" && /"partNumber":2\b/.test(record.rpcBody ?? ""),
    );
    await report.check(
      `${size}: multipart upload pauses, reloads, reselects and resumes with exact bytes`,
      async () => {
        await uploadFiles(page, source);
        await uploadsTray(page)
          .getByText(/\d+% · /)
          .waitFor();
        await enter(uploadsTray(page).getByRole("button", { name: `Pause upload of ${name}` }));
        await uploadsTray(page)
          .getByText(/Paused at/)
          .waitFor();
        release();
        await page.reload();
        await uploadsTray(page)
          .getByText(`Interrupted. Choose “${name}” again to continue.`)
          .waitFor();
        await report.shot(page, `readiness-${size}-interrupted-upload`);

        const begins = front.records.filter(
          (record) => record.operation === "uploads.begin",
        ).length;

        await chooseWith(
          page,
          () => uploadsTray(page).getByRole("button", { name: "Choose file", exact: true }).click(),
          source,
        );
        await clearUploads(page);
        assert.equal(
          front.records.filter((record) => record.operation === "uploads.begin").length,
          begins,
        );
        assert.deepEqual(
          await downloadBytes(page, () => menu(page, name, "Download")),
          readFileSync(source),
        );
      },
    );
    release();
    release = front.hold(
      (record) =>
        record.operation === "uploads.part" && /"partNumber":2\b/.test(record.rpcBody ?? ""),
    );
    await report.check(
      `${size}: cancelling an acknowledged multipart upload publishes no file`,
      async () => {
        const cancelled = `cancelled-${size}.bin`;
        await uploadFiles(page, media.bytes(cancelled, 8 * 1024 * 1024 + 337));
        await uploadsTray(page)
          .getByText(/\d+% · /)
          .waitFor();
        await enter(
          uploadsTray(page).getByRole("button", { name: `Cancel upload of ${cancelled}` }),
        );
        release();
        await uploadsTray(page).getByText("Cancelled", { exact: true }).waitFor();
        await enter(uploadsTray(page).getByRole("button", { name: `Remove ${cancelled}` }));
        await page.reload();
        await page.getByRole("button", { name: new RegExp(`^${name}`) }).waitFor();
        assert.equal(
          await page.getByRole("button", { name: new RegExp(`^${cancelled}`) }).count(),
          0,
        );
      },
    );
  } finally {
    release();
    await context.close();
  }
}

export async function runReadinessScenarios(run: CoreRun) {
  if (run.editorBundle === null) {
    for (const flow of ["open", "edit", "autosave", "save a copy", "changed-underneath conflict"]) {
      run.report.unverified(
        `Editor ${flow} (desktop and phone)`,
        "Real r2 bundle unavailable. The existing synthetic-persistence-test bundle contains blank, non-executable HTML and is rejected by production activation; it cannot prove this browser flow.",
      );
    }
  }

  for (const phone of [false, true]) {
    const label = phone ? "Phone" : "Desktop";
    await run.report.scenario(`${label} readiness: file sorting`, () =>
      runSortingScenarios(run, phone),
    );
    await run.report.scenario(`${label} readiness: file lifecycle`, () => lifecycle(run, phone));
    await run.report.scenario(`${label} readiness: multipart transfers`, () =>
      transfers(run, phone),
    );
    await run.report.scenario(`${label} readiness: account sharing roles`, () =>
      accountSharing(run, phone),
    );
    await run.report.scenario(`${label} readiness: protected contributor links`, () =>
      links(run, phone),
    );
    await run.report.scenario(`${label} readiness: offline and albums`, () =>
      recoveryAndAlbums(run, phone),
    );
    await run.report.scenario(`${label} readiness: login lockout`, () => lockout(run, phone));
    await runReadinessPhotoScenarios(run, phone);

    if (phone) await runAdminScenarios({ ...run, contextOptions: PHONE });
  }
}

/** Keep the no-reload Resume button distinct from persisted interruption recovery. */
export async function runResumeScenarios(run: CoreRun) {
  for (const phone of [false, true]) {
    const size = phone ? "phone" : "desktop";

    await run.report.scenario(`${size}: resume without reload`, async () => {
      const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
      const name = `resume-in-memory-${size}.bin`;
      const source = run.media.bytes(name, 8 * 1024 * 1024 + 2371);

      const release = run.front.hold(
        (record) =>
          record.operation === "uploads.part" && /"partNumber":2\b/.test(record.rpcBody ?? ""),
      );

      try {
        await run.report.check(
          `${size}: Resume without reload commits exact multipart bytes`,
          async () => {
            await uploadFiles(page, source);
            await uploadsTray(page)
              .getByText(/\d+% · /)
              .waitFor();
            await enter(uploadsTray(page).getByRole("button", { name: `Pause upload of ${name}` }));
            await uploadsTray(page)
              .getByText(/Paused at/)
              .waitFor();
            await enter(
              uploadsTray(page).getByRole("button", { name: `Resume upload of ${name}` }),
            );
            release();
            await clearUploads(page);
            assert.deepEqual(
              await downloadBytes(page, () => menu(page, name, "Download")),
              readFileSync(source),
            );
            await run.report.shot(page, `resume-without-reload-${size}`);
          },
        );
      } finally {
        release();
        await context.close();
      }
    });
  }
}
