import assert from "node:assert/strict";
import { join } from "node:path";
import type { Browser, Locator, Page, Route } from "playwright-core";
import { chooseWith, hydrated, signIn, uploadFiles, uploadsTray } from "./page-actions.ts";
import { accountPassword, addUser, openUsers } from "./scenarios-admin.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { PHONE } from "./scenarios-touch.ts";

type Options = Parameters<Browser["newContext"]>[0];

type Account = { readonly name: string; readonly email: string; password: string };

const INVALID_LINK =
  "This link is invalid, expired, or already used. Ask your administrator for a new one.";

// A visible pointer for the recorded clip, which headless capture doesn't draw.
async function showPointer(page: Page) {
  await page.evaluate(() => {
    const cursor = document.createElement("div");

    cursor.style.cssText =
      "position:fixed;pointer-events:none;z-index:9999;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #181614;left:0;top:0";
    document.body.append(cursor);
    document.addEventListener("mousemove", (event) => {
      cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
    });
  });
}

/** Moves there first when recording, so the clip shows hover feedback on the way. */
async function press(page: Page, target: Locator, recording: boolean) {
  if (recording) {
    const box = await target.boundingBox();

    assert.ok(box);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 20 });
  }

  await target.click();
}

async function signedIn(run: CoreRun, options: Options, account: Account) {
  const context = await freshContext(run, options);
  const page = await openPage(run, context);

  await signIn(page, account.email, account.password);
  await page.getByRole("navigation", { name: "Main" }).first().waitFor();

  return { context, page };
}

async function accountMenu(page: Page, account: Account, item: string, recording = false) {
  const compact = page.getByRole("button", { name: "Account", exact: true });

  const trigger = (await compact.isVisible())
    ? compact
    : page.getByRole("button", { name: new RegExp(`^${account.name}`) });

  await press(page, trigger, recording);
  await press(page, page.getByRole("menuitem", { name: item, exact: true }), recording);
}

/** The next request this browser makes finds its session ended, which leads only to sign-in. */
async function signedOutOnNextRequest(run: CoreRun, page: Page, shot: string) {
  await page.getByRole("link", { name: "Shared", exact: true }).first().click();
  await page.getByText("Your session has ended").waitFor();
  await run.report.shot(page, shot);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
}

async function signInWorks(run: CoreRun, options: Options, account: Account) {
  const { context } = await signedIn(run, options, account);

  await context.close();
}

async function signInRefused(run: CoreRun, options: Options, email: string, password: string) {
  const context = await freshContext(run, options);
  const page = await openPage(run, context);

  try {
    await signIn(page, email, password);
    await page.getByText("That email and password don’t match").waitFor();
  } finally {
    await context.close();
  }
}

function operationRequests(page: Page, operation: string) {
  const seen: number[] = [];

  page.on("response", (response) => {
    if ((response.request().postData() ?? "").includes(`"${operation}"`))
      seen.push(response.status());
  });

  return seen;
}

async function changePassword(
  run: CoreRun,
  label: string,
  options: Options,
  account: Account,
  recording: boolean,
) {
  const { report } = run;

  const a = await signedIn(
    run,
    recording
      ? {
          ...options,
          recordVideo: { dir: report.directory, size: { width: 1280, height: 800 } },
        }
      : options,
    account,
  );

  const b = await signedIn(run, options, account);
  const changes = operationRequests(a.page, "auth.changePassword");
  const replacement = accountPassword();

  try {
    if (recording) await showPointer(a.page);
    await accountMenu(a.page, account, "Change password…", recording);

    const dialog = a.page.getByRole("dialog", { name: "Change password" });
    const current = dialog.getByLabel("Current password");
    const next = dialog.getByLabel("New password");
    const submit = dialog.getByRole("button", { name: "Change password", exact: true });

    await current.fill("not the current password");
    await next.fill(replacement);
    await press(a.page, submit, recording);
    await report.check(`${label}: a wrong current password has its own message`, async () => {
      await dialog.getByText("Your current password wasn’t accepted. Try again.").waitFor();
      assert.equal(await current.inputValue(), "not the current password");
      assert.equal(await next.inputValue(), replacement);
    });
    await report.shot(a.page, `account-change-wrong-${label}`);

    await current.fill(account.password);
    await next.fill("eleven char");
    await press(a.page, submit, recording);
    await report.check(`${label}: a short new password has its own message`, async () => {
      await dialog.getByText("Use at least 12 characters.").waitFor();
      assert.equal(await next.getAttribute("aria-invalid"), "true");
      assert.equal(await current.inputValue(), account.password);
      assert.equal(await next.inputValue(), "eleven char");
      // Checked before sending: only the wrong-password attempt reached the server.
      assert.deepEqual(changes, [401]);
    });
    await report.shot(a.page, `account-change-short-${label}`);

    await next.fill(replacement);
    await press(a.page, submit, recording);
    await report.check(`${label}: browser A changes the password and stays signed in`, async () => {
      await a.page.getByText("Password changed", { exact: true }).waitFor();
      await dialog.waitFor({ state: "detached" });
      await report.shot(a.page, `account-change-done-${label}`);
      await a.page.reload();
      await a.page.getByRole("navigation", { name: "Main" }).first().waitFor();
      assert.equal(await a.page.getByRole("heading", { name: "Sign in" }).count(), 0);
    });

    await report.check(`${label}: browser B is signed out on its next request`, () =>
      signedOutOnNextRequest(run, b.page, `account-change-other-browser-${label}`),
    );

    await report.check(`${label}: the old password is refused and the new one works`, async () => {
      await signInRefused(run, options, account.email, account.password);
      account.password = replacement;
      await signInWorks(run, options, account);
    });
  } finally {
    const video = a.page.video();

    await a.context.close();
    await b.context.close();

    if (video) {
      await video.saveAs(join(report.directory, "account-change-password.webm"));
      await video.delete();
    }
  }
}

async function rateLimit(run: CoreRun, label: string, options: Options, account: Account) {
  const { context, page } = await signedIn(run, options, account);
  const changes = operationRequests(page, "auth.changePassword");

  try {
    await accountMenu(page, account, "Change password…");

    const dialog = page.getByRole("dialog", { name: "Change password" });
    const current = dialog.getByLabel("Current password");
    const next = dialog.getByLabel("New password");

    await current.fill("still not the password");
    await next.fill("a perfectly long new password");

    // Ten attempts per account in 15 minutes; the eleventh is refused before checking.
    for (let attempt = 0; attempt < 12 && !changes.includes(429); attempt += 1) {
      const answered = page.waitForResponse((response) =>
        (response.request().postData() ?? "").includes('"auth.changePassword"'),
      );

      await dialog.getByRole("button", { name: "Change password", exact: true }).click();
      await answered;
    }

    await run.report.check(`${label}: the rate limit has its own message`, async () => {
      assert.equal(changes.at(-1), 429);
      await dialog.getByText("Too many attempts").waitFor();
      await dialog.getByText("Wait up to 15 minutes, then try again.").waitFor();
      assert.equal(await current.inputValue(), "still not the password");
      assert.equal(await next.inputValue(), "a perfectly long new password");
    });
    await run.report.shot(page, `account-change-rate-limited-${label}`);
  } finally {
    await context.close();
  }
}

async function createResetLink(page: Page, account: Account) {
  await page.getByRole("button", { name: `Actions for ${account.name}`, exact: true }).click();
  await page.getByRole("menuitem", { name: "Reset password…", exact: true }).click();

  const dialog = page.getByRole("dialog", { name: "Reset password" });

  await dialog.getByRole("button", { name: "Create reset link" }).click();

  return dialog;
}

async function linkIn(dialog: Locator) {
  const link = await dialog.getByLabel("Reset link").inputValue();

  assert.match(link, /\/reset-password\/[^/]+$/);

  return link;
}

async function administratorReset(run: CoreRun, label: string, options: Options, account: Account) {
  const { report } = run;
  const owner = await ownerPage(run, options);
  const member = await signedIn(run, options, account);
  const replacement = accountPassword();

  try {
    await openUsers(owner.page);

    let dialog = await createResetLink(owner.page, account);
    const superseded = await linkIn(dialog);

    await report.shot(owner.page, `account-reset-link-${label}`);
    await dialog.getByRole("button", { name: "Done" }).click();
    await dialog.waitFor({ state: "detached" });

    await report.check(`${label}: the link is shown only while its dialog is open`, async () => {
      await owner.page
        .getByRole("button", { name: `Actions for ${account.name}`, exact: true })
        .click();
      await owner.page.getByRole("menuitem", { name: "Reset password…", exact: true }).click();
      dialog = owner.page.getByRole("dialog", { name: "Reset password" });
      await dialog.getByRole("button", { name: "Create reset link" }).waitFor();
      assert.equal(await dialog.getByLabel("Reset link").count(), 0);
    });

    await dialog.getByRole("button", { name: "Create reset link" }).click();
    const link = await linkIn(dialog);

    await dialog.getByRole("button", { name: "Done" }).click();

    const visitor = await freshContext(run, options);
    const page = await openPage(run, visitor, new URL(link).pathname);

    try {
      await page.getByRole("heading", { name: "Choose a new password" }).waitFor();
      await hydrated(page);
      await report.shot(page, `account-reset-page-${label}`);
      await page.getByLabel("New password").fill(replacement);
      await page.getByRole("button", { name: "Save password" }).click();
      await report.check(`${label}: the member redeems the link in a fresh browser`, () =>
        page.getByRole("heading", { name: "Password changed" }).waitFor(),
      );
      await report.shot(page, `account-reset-done-${label}`);

      await report.check(`${label}: every session of that account ends`, () =>
        signedOutOnNextRequest(run, member.page, `account-reset-other-session-${label}`),
      );

      await report.check(`${label}: sign-in works with the new password`, async () => {
        await page.getByRole("button", { name: "Sign in" }).click();
        await page.getByRole("heading", { name: "Sign in", exact: true }).waitFor();
        await signIn(page, account.email, replacement);
        await page.getByRole("navigation", { name: "Main" }).first().waitFor();
        account.password = replacement;
      });
    } finally {
      await visitor.close();
    }

    for (const [name, path] of [
      ["the same link again", new URL(link).pathname],
      ["a superseded link", new URL(superseded).pathname],
    ] as const) {
      const again = await freshContext(run, options);
      const revisit = await openPage(run, again, path);

      try {
        // Rendered on the server: typing before hydration would be lost to a native submit.
        await hydrated(revisit);
        await revisit.getByLabel("New password").fill(accountPassword());
        await revisit.getByRole("button", { name: "Save password" }).click();
        await report.check(`${label}: opening ${name} shows the invalid-link message`, () =>
          revisit.getByText(INVALID_LINK).waitFor(),
        );
        await report.shot(revisit, `account-reset-invalid-${name.replaceAll(" ", "-")}-${label}`);
      } finally {
        await again.close();
      }
    }
  } finally {
    await owner.context.close();
    await member.context.close();
  }
}

async function pendingUploads(run: CoreRun, label: string, options: Options, account: Account) {
  const { report, media } = run;
  const cancelled = media.bytes(`pending-cancel-${label}.bin`, 20 * 1024 * 1024);
  const resumed = media.bytes(`pending-resume-${label}.bin`, 20 * 1024 * 1024);
  const a = await signedIn(run, options, account);
  const b = await signedIn(run, options, account);
  const held: Route[] = [];

  try {
    // Parts wait here, so both uploads have begun on the server and nothing has been stored yet.
    await a.context.route("**/api/storage/uploads/**", (route) => {
      held.push(route);
    });
    await uploadFiles(a.page, [cancelled, resumed]);

    for (const file of [cancelled, resumed]) {
      const name = file.split("/").at(-1) ?? file;
      // Enabled once the upload has begun on the server and its first part is on its way.
      await uploadsTray(a.page)
        .getByRole("button", { name: `Pause upload of ${name}` })
        .click();
    }

    await a.context.unroute("**/api/storage/uploads/**");
    await Promise.all(held.map((route) => route.abort().catch(() => undefined)));
    // A reload keeps only what this browser saved: two interrupted uploads it can resume.
    await a.page.reload();
    await uploadsTray(a.page).getByText("Interrupted.").first().waitFor();

    await accountMenu(b.page, account, "Unfinished uploads");
    const elsewhere = b.page.getByRole("list", { name: "Unfinished uploads" });

    await report.check(`${label}: an upload paused in browser A appears in browser B`, async () => {
      await elsewhere.getByText("pending-cancel-").waitFor();
      await elsewhere.getByText("pending-resume-").waitFor();
      assert.equal(await elsewhere.getByText("Can only be cancelled here").count(), 2);
    });
    await report.shot(b.page, `account-pending-other-browser-${label}`);

    await report.check(`${label}: cancelling in browser B removes it in both`, async () => {
      await elsewhere
        .getByRole("button", { name: `Cancel upload of pending-cancel-${label}.bin` })
        .click();
      await elsewhere.getByText(`pending-cancel-${label}.bin`).waitFor({ state: "detached" });
      await accountMenu(a.page, account, "Unfinished uploads");
      const here = a.page.getByRole("list", { name: "Unfinished uploads" });

      await here.getByText(`pending-resume-${label}.bin`).first().waitFor();
      assert.equal(await here.getByText(`pending-cancel-${label}.bin`).count(), 0);
    });

    const here = a.page.getByRole("list", { name: "Unfinished uploads" });

    await here.getByText(`Choose “pending-resume-${label}.bin” to continue`).waitFor();
    await report.shot(a.page, `account-pending-this-browser-${label}`);

    await report.check(`${label}: a resumable upload resumes after reselecting it`, async () => {
      await chooseWith(
        a.page,
        () => here.getByRole("button", { name: "Choose file" }).click(),
        resumed,
      );
      await a.page
        .getByRole("dialog", { name: "Unfinished uploads" })
        .getByText("Nothing unfinished.", {
          exact: false,
        })
        .waitFor({ timeout: 60_000 });
      await a.page.getByRole("button", { name: "Done" }).click();
      await uploadsTray(a.page).getByLabel("Uploaded").first().waitFor({ timeout: 60_000 });
      await a.page
        .getByRole("button", { name: new RegExp(`pending-resume-${label}`) })
        .first()
        .waitFor();
    });
    await report.shot(a.page, `account-pending-resumed-${label}`);
  } finally {
    await a.context.close();
    await b.context.close();
  }
}

async function uploadLimit(run: CoreRun, label: string, options: Options, account: Account) {
  const { context, page } = await signedIn(run, options, account);

  try {
    // Seeded through the same API a browser uses: 128 begun, never-sent uploads.
    const statuses = await page.evaluate(async () => {
      const seen: number[] = [];

      for (let index = 0; index < 128; index += 1) {
        const response = await fetch("/api/rpc", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            operation: "uploads.begin",
            input: {
              name: `seed-${index}.bin`,
              parentId: null,
              size: 1,
              mimeType: "application/octet-stream",
            },
          }),
        });

        seen.push(response.status);
      }

      return seen;
    });

    assert.deepEqual(new Set(statuses), new Set([200]));
    await uploadFiles(page, run.media.bytes(`over-the-limit-${label}.bin`, 1024));
    await run.report.check(`${label}: the 128-upload limit has its own message`, () =>
      uploadsTray(page).getByText("You’ve reached the limit on unfinished uploads.").waitFor(),
    );
    await run.report.shot(page, `account-upload-limit-${label}`);
  } finally {
    await context.close();
  }
}

export async function runAccountScenarios(run: CoreRun) {
  for (const phone of [false, true]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const label = `${phone ? "phone" : "desktop"}-${colorScheme}`;
      const options = { ...(phone ? PHONE : { deviceScaleFactor: 2 }), colorScheme };

      // The administrator may add ten accounts in 15 minutes, so each width and scheme uses two.
      const person = {
        name: `Rania ${label}`,
        email: `rania-${label}@example.test`,
        password: accountPassword(),
      };

      const uploader = {
        name: `Omar ${label}`,
        email: `omar-${label}@example.test`,
        password: accountPassword(),
      };

      await run.report.scenario(`Account ${label}`, async () => {
        const admin = await ownerPage(run);

        try {
          await openUsers(admin.page);

          for (const account of [person, uploader])
            await addUser(admin.page, account.name, account.email, account.password);
        } finally {
          await admin.context.close();
        }

        // Change spends two of the account's ten attempts, so the limit follows on the same one.
        await changePassword(run, label, options, person, label === "desktop-light");
        await rateLimit(run, label, options, person);
        await administratorReset(run, label, options, person);
        await pendingUploads(run, label, options, uploader);
        await uploadLimit(run, label, options, uploader);
      });
    }
  }
}
