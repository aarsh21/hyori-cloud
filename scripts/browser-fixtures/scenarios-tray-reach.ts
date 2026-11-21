import assert from "node:assert/strict";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@hyori-cloud/client-sdk";
import type { Locator, Page } from "playwright-core";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { accountPassword, openUsers } from "./scenarios-admin.ts";
import { closeViewer } from "./scenarios-photos.ts";
import {
  filesBarAction,
  filesSearch,
  hydrated,
  openTrash,
  signIn,
  uploadFiles,
  uploadsTray,
} from "./page-actions.ts";
import { PHONE } from "./scenarios-touch.ts";

// Seed through product operations, using this browser's cookies and certificate trust.
function clientFor(page: Page) {
  return createClient({
    fetch: async (url, init) => {
      const result = await page.evaluate(
        async ({ url, body }) => {
          const response = await fetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body,
          });

          return { body: await response.text(), status: response.status };
        },
        { url: String(url), body: String(init?.body) },
      );

      return new Response(result.body, { status: result.status });
    },
  });
}

async function atEnd(page: Page) {
  const body = page.locator('[data-slot="page-body"]');
  const more = page.getByRole("button", { name: "Load more", exact: true });

  // Load every page before measuring the last item, even on the obstructed base layout.
  while (await more.count()) {
    const response = page.waitForResponse(
      (response) =>
        response.url().endsWith("/api/rpc") &&
        (response.request().postData() ?? "").includes('"cursor":'),
    );

    await more.press("Enter");
    await response;
    await page.getByRole("button", { name: "Loading…", exact: true }).waitFor({ state: "hidden" });
  }

  await body.evaluate(async (element) => {
    let stable = 0;
    let height = 0;

    // content-visibility and virtualization can change scrollHeight on the next layout frame.
    for (let frame = 0; frame < 60 && stable < 3; frame += 1) {
      element.scrollTop = element.scrollHeight;
      await new Promise(requestAnimationFrame);
      stable =
        height === element.scrollHeight &&
        Math.abs(element.scrollTop + element.clientHeight - element.scrollHeight) < 1
          ? stable + 1
          : 0;
      height = element.scrollHeight;
    }
  });
}

async function layout(page: Page, control: Locator) {
  const box = await control.boundingBox();
  assert.ok(box);
  const tray = await uploadsTray(page).boundingBox();

  const scroll = await page.locator('[data-slot="page-body"]').evaluate((element) => ({
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
    scrollTop: element.scrollTop,
    top: element.getBoundingClientRect().top,
    bottom: element.getBoundingClientRect().bottom,
  }));

  return { box, tray, scroll };
}

async function pointerCheck(run: CoreRun, page: Page, label: string, photo = false) {
  const controls = photo
    ? page.locator('[data-slot="media-tile"] button[data-item-target]')
    : page
        .locator('[data-slot="page-body"]')
        .getByRole("button", { name: /^(Actions|More actions) for / });

  await controls.first().waitFor({ state: "attached" });
  await atEnd(page);

  const control = controls.last();

  const measured = await layout(page, control);
  const name = await control.getAttribute("aria-label");
  run.report.observe(label, { ...measured, control: name });

  await run.report.check(
    `${label}: last control is fully clear and pointer-clickable`,
    async () => {
      const { box, tray, scroll } = measured;
      assert.ok(scroll.scrollHeight > scroll.clientHeight, "fixture must require scrolling");
      // Real coordinates, not locator auto-scroll or keyboard activation: expose intercepted clicks.
      await page.mouse.move(box.x - 24, box.y + box.height / 2, { steps: 12 });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 12 });
      await run.report.shot(page, `tray-reach-${label}`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);

      if (photo) await page.locator('[data-slot="lightbox"]').waitFor({ timeout: 2000 });
      else
        await page.getByRole("menu", { name: name ?? "", exact: true }).waitFor({ timeout: 2000 });
      assert.ok(
        Math.abs(scroll.scrollTop + scroll.clientHeight - scroll.scrollHeight) <= 1,
        "must be at maximum scroll",
      );
      assert.ok(
        box.y >= scroll.top && box.y + box.height <= scroll.bottom,
        "entire control must be inside the scroll viewport",
      );
      assert.ok(
        tray !== null &&
          (box.y + box.height <= tray.y ||
            box.x + box.width <= tray.x ||
            box.x >= tray.x + tray.width),
        "entire control must be clear of tray",
      );
    },
  );

  if (photo && (await page.locator('[data-slot="lightbox"]').count())) await closeViewer(page);
  else {
    await page.keyboard.press("Escape");
    await page.getByRole("menu").waitFor({ state: "hidden" });
  }
}

async function setTrayCollapsed(page: Page, collapsed: boolean) {
  const toggle = uploadsTray(page).getByRole("button", {
    name: collapsed ? "Hide uploads" : "Show uploads",
  });

  if (await toggle.count()) await toggle.click();
}

async function openLibrary(page: Page) {
  await page.getByRole("link", { name: "Files", exact: true }).first().click();
  await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  // The fixture can be beyond the first page at the root; use the product's server-side search.
  await (await filesSearch(page)).fill("Tray reach library");
  await page.getByRole("link", { name: /^Tray reach library/ }).click();
}

async function trayState(page: Page, run: CoreRun, state: string, prefix: string) {
  const tray = uploadsTray(page);
  await setTrayCollapsed(page, state === "collapsed");

  if (state === "maximum") {
    const files = Array.from({ length: 10 }, (_, i) =>
      run.media.bytes(`${prefix}-${i}.bin`, 71 + i),
    );

    await uploadFiles(page, files);
    await tray.getByRole("heading", { name: "11 uploads complete", exact: true }).waitFor();
    const height = await tray.evaluate((element) => element.getBoundingClientRect().height);
    assert.ok(Math.abs(height - 384) < 1, `maximum tray is ${height}, expected 24rem`);
  }
}

export async function runTrayReachScenarios(run: CoreRun) {
  const seed = await ownerPage(run);
  const sdk = clientFor(seed.page);
  const library = await sdk.rpc.files.createFolder({ parentId: null, name: "Tray reach library" });
  const status = await sdk.rpc.auth.status({});
  assert.ok(status.user);
  const password = accountPassword();
  const email = "tray-reach-owner@example.test";
  await sdk.rpc.admin.createUser({ name: "Tray source owner", email, password });

  for (let index = 0; index < 208; index += 1) {
    await sdk.rpc.files.createFolder({
      parentId: library.id,
      name: `Reach folder ${String(index).padStart(3, "0")}`,
    });
  }

  for (let index = 0; index < 32; index += 1) {
    const trash = await sdk.rpc.files.createFolder({
      parentId: null,
      name: `Reach discarded ${index}`,
    });

    await sdk.rpc.files.trash({ id: trash.id });
  }

  // Layout-only users need no credentials. Seed disposable rows without bypassing account rate limits.
  run.stack.sql(`INSERT INTO hyori_users(id,email,name,role,quota_bytes)
    SELECT 'tray_reach_'||n, 'tray-reach-'||n||'@example.test', 'Reach member '||n, 'user', 10000000000
    FROM generate_series(1,32) n`);

  const share = await sdk.rpc.shares.create({
    itemId: library.id,
    public: true,
    role: "editor",
  });

  assert.ok(share.url);
  const shareUrl = new URL(share.url, run.origin).href;
  await seed.page.goto(`${run.origin}/folders/${library.id}`);
  const source = run.media.png("tray-source.png", 37, "320x240");

  const photos = Array.from({ length: 66 }, (_, index) => {
    const target = join(run.media.directory, `reach-photo-${String(index).padStart(2, "0")}.png`);
    copyFileSync(source, target);

    return target;
  });

  await uploadFiles(seed.page, photos);
  await uploadsTray(seed.page)
    .getByRole("heading", { name: "66 uploads complete", exact: true })
    .waitFor({ timeout: 90_000 });
  sdk.dispose();
  await seed.context.close();

  // A different owner supplies real account-shared rows; the browsing user remains the admin.
  const contributorContext = await freshContext(run);

  const contributor = {
    context: contributorContext,
    page: await openPage(run, contributorContext),
  };

  await signIn(contributor.page, email, password);
  await contributor.page.getByRole("heading", { name: "Files", exact: true }).waitFor();
  const owner = clientFor(contributor.page);

  for (let index = 0; index < 32; index += 1) {
    const item = await owner.rpc.files.createFolder({
      parentId: null,
      name: `Reach shared ${String(index).padStart(2, "0")}`,
    });

    await owner.rpc.shares.create({
      itemId: item.id,
      public: false,
      recipientId: status.user.id,
      role: "editor",
    });
  }

  owner.dispose();
  await contributor.context.close();

  for (const phone of [false, true])
    for (const colorScheme of ["light", "dark"] as const) {
      const label = `${phone ? "phone" : "desktop"}-${colorScheme}`;
      const recording = label === "desktop-light";

      const options = {
        ...(phone ? PHONE : { deviceScaleFactor: 2 }),
        colorScheme,
        recordVideo: recording
          ? { dir: run.report.directory, size: { width: 1280, height: 800 } }
          : undefined,
      };

      await run.report.scenario(`Tray reach ${label}`, async () => {
        const { context, page } = await ownerPage(run, options);

        if (recording)
          await page.evaluate(() => {
            const cursor = document.createElement("div");
            cursor.style.cssText =
              "position:fixed;pointer-events:none;z-index:9999;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #181614;left:0;top:0";
            document.body.append(cursor);
            document.addEventListener("mousemove", (event) => {
              cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
            });
          });

        try {
          await openLibrary(page);
          await page.locator('[data-slot="item-table-row"]').first().waitFor();
          await atEnd(page);

          const noTray = await page.locator('[data-slot="page-body"]').evaluate((element) => ({
            scrollHeight: element.scrollHeight,
            clientHeight: element.clientHeight,
          }));

          run.report.observe(`no-tray-${label}`, noTray);
          await run.report.shot(page, `tray-reach-no-tray-${label}`);
          await uploadFiles(page, run.media.bytes(`${label}-complete.bin`, 127));
          await uploadsTray(page).getByLabel("Uploaded").waitFor();

          for (const state of ["expanded", "collapsed", "maximum"]) {
            // Return to the writable folder before adding the batch which fills the tray.
            await openLibrary(page);
            await trayState(page, run, state, label);

            for (const screen of [
              "files-list",
              "files-grid",
              "photos",
              "shared",
              "trash",
              "users",
            ]) {
              if (screen.startsWith("files-")) {
                await filesBarAction(page, screen === "files-list" ? "List" : "Grid");
              } else if (screen === "users") await openUsers(page);
              else if (screen === "trash") await openTrash(page);
              else {
                const name = { photos: "Photos", shared: "Shared", trash: "Trash" }[screen];
                assert.ok(name);
                await page.getByRole("link", { name, exact: true }).first().click();
              }

              await setTrayCollapsed(page, state === "collapsed");
              await pointerCheck(run, page, `${label}-${state}-${screen}`, screen === "photos");
            }
          }

          await uploadsTray(page).getByRole("button", { name: "Clear", exact: true }).click();
          await uploadsTray(page).waitFor({ state: "detached" });
          await openLibrary(page);
          await filesBarAction(page, "List");
          await run.report.check(`${label}: clearing restores the original viewport`, async () => {
            const height = await page
              .locator('[data-slot="page-body"]')
              .evaluate((element) => element.clientHeight);

            assert.equal(height, noTray.clientHeight);
          });

          await context.clearCookies();
          await page.goto(shareUrl);
          await hydrated(page);
          await page.getByRole("button", { name: "Open", exact: true }).click();
          await page.getByRole("heading", { name: library.name, exact: true }).waitFor();
          await uploadFiles(page, run.media.bytes(`${label}-public-complete.bin`, 127));
          await uploadsTray(page).getByLabel("Uploaded").waitFor();

          for (const state of ["expanded", "collapsed", "maximum"]) {
            await trayState(page, run, state, `${label}-public`);
            await pointerCheck(run, page, `${label}-${state}-public-folder`);
          }
        } finally {
          await context.close();

          if (recording)
            run.report.observe(`pointer-video-${label}`, (await page.video()?.path()) ?? null);
        }
      });
    }
}
