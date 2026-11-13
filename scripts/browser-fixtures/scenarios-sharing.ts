import assert from "node:assert/strict";
import type { Page } from "playwright-core";
import {
  chooseWith,
  fetchInPage,
  hydrated,
  rowMenu,
  uploadFiles,
  uploadsTray,
} from "./page-actions.ts";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";

export async function createLink(page: Page, itemName: string, role: "Viewer" | "Editor") {
  await rowMenu(page, itemName, "Share…");

  const dialog = page.getByRole("dialog");

  await dialog.getByRole("button", { name: "Create link" }).click();
  await dialog.getByRole("combobox", { name: /Anyone with the link can/ }).click();
  await page.getByRole("option", { name: new RegExp(`^${role}`) }).click();
  await dialog.getByRole("button", { name: "Create link" }).click();

  const field = dialog.getByRole("textbox", { name: "Public link" });

  await field.waitFor();

  const url = await field.inputValue();

  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "detached" });

  return url;
}

export async function revokeLink(page: Page, itemName: string) {
  await rowMenu(page, itemName, "Share…");

  const dialog = page.getByRole("dialog");

  await dialog.getByRole("button", { name: "Revoke" }).click();

  const confirmation = page.getByRole("alertdialog");

  await confirmation.getByRole("button", { name: "Revoke link" }).click();
  await confirmation.waitFor({ state: "detached" });
  await dialog.getByRole("button", { name: "Done" }).click();
  await dialog.waitFor({ state: "detached" });
}

async function publicFile(run: CoreRun) {
  const { report, media } = run;
  const { context: ownerContext, page: owner } = await ownerPage(run);
  const name = "shared brief.bin";

  await uploadFiles(owner, media.bytes(name, 4096));
  await uploadsTray(owner).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
  await uploadsTray(owner).getByRole("button", { name: "Clear" }).click();

  const url = await createLink(owner, name, "Editor");

  await report.check("a link's URL is real, and asks before opening", async () => {
    assert.ok(url.startsWith(run.origin), `unexpected link: ${url}`);
  });

  const visitorContext = await freshContext(run);
  const visitor = await openPage(run, visitorContext, new URL(url).pathname);

  await hydrated(visitor);
  await visitor.getByRole("button", { name: "Open shared item" }).click();
  await visitor.getByRole("heading", { name }).waitFor();
  await report.shot(visitor, "public-file-desktop");

  await report.check(
    "a shared link's document renders on the server without a failed boundary",
    async () => {
      const { status, text: html } = await fetchInPage(visitor, url);
      const body = html.slice(html.indexOf("</head>"));
      const failed = (body.match(/<!--\$!/g) ?? []).length;

      report.observe("shared link document", {
        status,
        failedBoundaries: failed,
        sample: body.replace(/<script[\s\S]*?<\/script>/g, "").slice(0, 240),
      });
      assert.equal(failed, 0);
    },
  );

  await report.check(
    "a visitor's new version updates the page, and stays after clearing the tray",
    async () => {
      await visitor.getByText("4 KB").waitFor();
      await visitor.getByRole("button", { name: "Upload new version" }).click();

      const dialog = visitor.getByRole("dialog");
      const source = media.bytes("visitor edit.bin", 8192);

      await chooseWith(
        visitor,
        () => dialog.getByRole("button", { name: "Choose file…" }).click(),
        source,
      );
      await dialog.getByRole("button", { name: "Upload new version" }).click();

      const tray = uploadsTray(visitor);

      await tray.getByLabel("Uploaded").waitFor({ timeout: 30_000 });
      await visitor.getByRole("button", { name: "Clear" }).click();
      await tray.waitFor({ state: "detached" });
      await visitor.getByText("8 KB").waitFor();
    },
  );

  await report.check("revoking stops the page offering the file on its next request", async () => {
    await revokeLink(owner, name);

    const download = visitor.getByRole("button", { name: "Download" });

    await download.click();
    await visitor.getByRole("button", { name: "Open link again" }).first().waitFor();
    await report.shot(visitor, "public-file-revoked-download");
  });

  await report.check(
    "recovering a revoked link says it's gone rather than restoring access",
    async () => {
      await visitor.getByRole("button", { name: "Open link again" }).first().click();
      const timeline: string[] = [];

      for (let sample = 0; sample < 12; sample += 1) {
        timeline.push((await visitor.getByRole("alert").allInnerTexts()).join(" / ").slice(0, 70));
        await visitor.waitForTimeout(100);
      }

      report.observe("alert text after reopening a revoked link", timeline);
      report.observe(
        "shares.resolve statuses",
        run.front.records
          .filter((record) => record.operation === "shares.resolve")
          .map((record) => record.status),
      );
      await visitor.getByText("This link no longer works").first().waitFor();
      assert.deepEqual(
        await visitor.getByRole("button", { name: "Open link again" }).count(),
        0,
        "reopen buttons",
      );
    },
  );

  await visitorContext.close();
  await ownerContext.close();
}

async function publicViewer(run: CoreRun) {
  const { report, media } = run;
  const { context: ownerContext, page: owner } = await ownerPage(run);
  const folder = "Shared album";

  await owner.getByRole("button", { name: "New folder" }).first().click();
  await owner.getByRole("dialog").getByLabel("Name", { exact: true }).fill(folder);
  await owner.getByRole("button", { name: "Create" }).click();
  await owner.getByRole("link", { name: new RegExp(`^${folder}`) }).waitFor();

  const url = await createLink(owner, folder, "Viewer");

  await owner.getByRole("link", { name: new RegExp(`^${folder}`) }).click();
  await owner.getByRole("heading", { name: folder }).waitFor();
  await uploadFiles(owner, [
    media.png("one.png", 1),
    media.png("two.png", 2),
    media.png("three.png", 3),
  ]);

  for (const name of ["one", "two", "three"]) {
    await owner
      .getByRole("button", { name: new RegExp(`^${name}\\.png`) })
      .waitFor({ timeout: 30_000 });
  }

  await uploadsTray(owner).getByRole("button", { name: "Clear" }).click();

  const visitorContext = await freshContext(run);
  const visitor = await openPage(run, visitorContext, new URL(url).pathname);

  await hydrated(visitor);
  await visitor.getByRole("button", { name: "Open shared item" }).click();
  await visitor.getByRole("button", { name: /^one\.png/ }).click();

  const lightbox = visitor.locator('[data-slot="lightbox"]');

  await report.check("a visitor's viewer shows the image, decoded", async () => {
    await visitor.waitForFunction(() => {
      const image = document.querySelector<HTMLImageElement>('[data-slot="lightbox"] img');

      return image !== null && image.complete && image.naturalWidth > 0;
    });
  });

  await report.shot(visitor, "public-viewer");

  await owner.getByRole("link", { name: "Files" }).first().click();
  await owner.getByRole("link", { name: new RegExp(`^${folder}`) }).waitFor();
  await revokeLink(owner, folder);

  await report.check(
    "after revocation, moving to the next photo shows lost access and recovery",
    async () => {
      // Whichever neighbour exists: the listing's order isn't this test's concern.
      await visitor
        .locator('[data-slot="lightbox"]')
        .getByRole("button", { name: /^(Next|Previous)$/ })
        .first()
        .click();
      await lightbox.getByRole("button", { name: "Open link again" }).waitFor({ timeout: 20_000 });
      await lightbox.getByRole("alert").waitFor();
      assert.deepEqual(await lightbox.locator("img").count(), 0, "images still shown");
    },
  );

  await report.shot(visitor, "public-viewer-revoked");

  await visitorContext.close();
  await ownerContext.close();
}

export async function runSharingScenarios(run: CoreRun) {
  await run.report.scenario("Public file link", () => publicFile(run));
  await run.report.scenario("Public viewer and revocation", () => publicViewer(run));
}
