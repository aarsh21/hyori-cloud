import assert from "node:assert/strict";
import { chmodSync, readdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import type { Locator, Page } from "playwright-core";
import { ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { openUsers } from "./scenarios-admin.ts";
import { PHONE } from "./scenarios-touch.ts";
import { uploadFiles, uploadsTray } from "./page-actions.ts";

// A DOM presence assertion misses ellipsis and ancestor clipping. Measure the actual glyph range.
async function readable(locator: Locator, text: string) {
  assert.equal(
    await locator.evaluate((element, needle) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      let node;

      while ((node = walker.nextNode())) {
        const start = node.textContent?.indexOf(needle) ?? -1;

        if (start < 0) continue;
        const range = document.createRange();
        range.setStart(node, start);
        range.setEnd(node, start + needle.length);
        const rect = range.getBoundingClientRect();

        if (rect.width === 0 || rect.left < 0 || rect.right > innerWidth) continue;
        let clipped = false;

        for (
          let parent: Element | null = node.parentElement;
          parent;
          parent = parent.parentElement
        ) {
          if (getComputedStyle(parent).overflowX === "visible") continue;
          const bounds = parent.getBoundingClientRect();

          if (rect.left < bounds.left - 1 || rect.right > bounds.right + 1) clipped = true;
        }

        if (!clipped) return true;
      }

      return false;
    }, text),
    true,
    `${text} is clipped`,
  );
}

async function folder(page: Page, name: string) {
  await page.getByRole("button", { name: "New folder", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Name", { exact: true }).fill(name);
  await dialog.getByLabel("Name", { exact: true }).press("Enter");
  await dialog.waitFor({ state: "detached" });
  await page.getByRole("link", { name: new RegExp(`^${name}`) }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}

export async function runInterfaceScenarios(run: CoreRun) {
  await warmNavigation(run);
  // Real stored bytes and quota, not a substituted response or a fabricated storage counter.
  const seed = await ownerPage(run);
  await uploadFiles(seed.page, run.media.bytes("interface-layout.bin", 3_040_870));
  await uploadsTray(seed.page).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
  await seed.context.close();
  run.stack.sql(
    "UPDATE hyori_users SET email='browser-review@example.test' WHERE email='noor@example.test'",
  );

  for (const phone of [false, true]) {
    for (const colorScheme of ["light", "dark"] as const) {
      const label = `${phone ? "phone" : "desktop"}-${colorScheme}`;
      const options = { ...(phone ? PHONE : { deviceScaleFactor: 2 }), colorScheme };
      await run.report.scenario(`Interface ${label}`, async () => {
        const { context, page } = await ownerPage(run, options);

        try {
          await openUsers(page);
          await page.getByRole("list", { name: "Users", exact: true }).waitFor();
          await run.report.shot(page, `interface-users-${label}`);

          const row = page
            .locator('[data-slot="item-table-row"]')
            .filter({ hasText: "browser-review@example.test" });

          await run.report.check(`${label}: full Admin badge is readable`, () =>
            readable(row, "Admin"),
          );
          await run.report.check(`${label}: full storage figure is readable`, () =>
            readable(row, "2.9 MB of 10 GB used"),
          );
          await page.goto(run.origin);
          const name = `Role test ${label}`;
          await folder(page, name);
          await run.report.shot(page, `interface-folder-${label}`);
          await run.report.check(
            `${label}: root breadcrumb is readable and clickable`,
            async () => {
              const path = page.getByRole("navigation", { name: "Folder path" });
              const root = path.getByRole("link", { name: "Files", exact: true });
              await readable(root, "Files");
              await root.click({ timeout: 3000 });
              await page.getByRole("heading", { name: "Files", exact: true }).waitFor();
              assert.equal(new URL(page.url()).pathname, "/");
            },
          );
        } finally {
          await context.close();
        }

        // Fresh context: neither the catch-all route nor the Shared screen has been fetched.
        const recording = label === "desktop-light";

        const cold = await ownerPage(
          run,
          recording
            ? {
                ...options,
                recordVideo: { dir: run.report.directory, size: { width: 1280, height: 800 } },
              }
            : options,
        );

        if (recording)
          await cold.page.evaluate(() => {
            const cursor = document.createElement("div");
            cursor.style.cssText =
              "position:fixed;pointer-events:none;z-index:9999;width:12px;height:12px;border-radius:50%;background:#fff;border:2px solid #181614;left:0;top:0";
            document.body.append(cursor);
            document.addEventListener("mousemove", (event) => {
              cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
            });
          });
        const documents: string[] = [];
        const navigationReasons: string[] = [];
        const cdp = await cold.context.newCDPSession(cold.page);
        await cdp.send("Page.enable");
        cdp.on("Page.frameRequestedNavigation", ({ reason }) => navigationReasons.push(reason));
        cold.page.on("request", (request) => {
          if (request.isNavigationRequest()) documents.push(request.url());
        });

        try {
          await cold.page.waitForLoadState("networkidle");
          await cold.context.setOffline(true);

          if (recording) {
            for (const name of ["Files", "Photos", "Shared"]) {
              const box = await cold.page
                .getByRole("link", { name, exact: true })
                .first()
                .boundingBox();

              assert.ok(box);
              await cold.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
                steps: 25,
              });
            }
          }

          await cold.page.getByRole("link", { name: "Shared", exact: true }).first().click();
          await run.report.check(
            `${label}: cold offline route retains shell and Retry without reloading`,
            async () => {
              await cold.page
                .getByText("You’re offline", { exact: true })
                .waitFor({ timeout: 5000 });
              await cold.page.getByRole("button", { name: "Retry", exact: true }).waitFor();
              assert.equal(
                await cold.page
                  .getByRole("navigation", { name: "Main", exact: true })
                  .first()
                  .isVisible(),
                true,
              );
              assert.deepEqual(documents, []);
              const retry = cold.page.getByRole("button", { name: "Retry", exact: true });

              if (recording) {
                const box = await retry.boundingBox();
                assert.ok(box);
                await cold.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, {
                  steps: 35,
                });
              }

              await retry.click();
              await cold.page.getByText("You’re offline", { exact: true }).waitFor();
            },
          );
          await run.report.shot(cold.page, `interface-offline-${label}`);
          run.report.observe(`${label} offline document requests`, documents);
          run.report.observe(`${label} document navigation reasons`, navigationReasons);
          run.report.observe(
            `${label} router reload markers`,
            await cold.page
              .evaluate(() =>
                Object.keys(sessionStorage).filter((key) =>
                  key.startsWith("tanstack_router_reload:"),
                ),
              )
              .catch(() => []),
          );
          await cold.context.setOffline(false);
          await run.report.check(
            `${label}: online event loads Shared without reload or click`,
            async () => {
              await cold.page
                .getByRole("heading", { name: "Shared with me", exact: true })
                .waitFor({ timeout: 10000 });
              assert.deepEqual(documents, []);
            },
          );
          await run.report.shot(cold.page, `interface-recovered-${label}`);

          if (recording) await cold.page.mouse.move(470, 330, { steps: 40 });
        } finally {
          const video = cold.page.video();
          await cold.context.setOffline(false);
          await cold.context.close();

          if (video) {
            await video.saveAs(join(run.report.directory, "offline-recovery.webm"));
            await video.delete();
          }
        }

        const warm = await ownerPage(run, options);

        try {
          await warm.page.getByRole("link", { name: "Trash", exact: true }).first().click();
          await warm.page.getByRole("heading", { name: "Trash", exact: true }).waitFor();
          // The fallback has the same heading. Finish the first visit before testing a return.
          await warm.page.waitForFunction(
            () =>
              document.querySelector('[data-slot="skeleton"], [data-slot$="-skeleton"]') === null,
          );
          await warm.page.getByRole("link", { name: "Files", exact: true }).first().click();
          await warm.page.getByRole("heading", { name: "Files", exact: true }).waitFor();
          await run.report.check(
            `${label}: returning to a loaded section shows no skeleton`,
            async () => {
              await warm.page.evaluate(() => {
                const skeleton = '[data-slot="skeleton"], [data-slot$="-skeleton"]';
                new MutationObserver((records) => {
                  for (const record of records)
                    for (const node of record.addedNodes)
                      if (
                        node instanceof Element &&
                        (node.matches(skeleton) || node.querySelector(skeleton) !== null)
                      )
                        document.body.dataset.skeletonsShown = `${document.body.dataset.skeletonsShown ?? ""}${location.pathname} `;
                }).observe(document.body, { childList: true, subtree: true });
              });

              for (const name of ["Trash", "Files", "Trash", "Files"]) {
                await warm.page.getByRole("link", { name, exact: true }).first().click();
                await warm.page.getByRole("heading", { name, exact: true }).waitFor();
              }

              assert.deepEqual(
                await warm.page.evaluate(() => document.body.dataset.skeletonsShown),
                undefined,
              );
            },
          );
          await warm.page.waitForLoadState("networkidle");
          await warm.context.setOffline(true);
          await warm.page.getByRole("link", { name: "Shared", exact: true }).first().click();
          await run.report.check(
            `${label}: cached router also retains shell on offline screen failure`,
            async () => {
              await warm.page
                .getByText("You’re offline", { exact: true })
                .waitFor({ timeout: 5000 });
              assert.equal(
                await warm.page
                  .getByRole("navigation", { name: "Main", exact: true })
                  .first()
                  .isVisible(),
                true,
              );
            },
          );
          await run.report.shot(warm.page, `interface-offline-warm-route-${label}`);
          await warm.context.setOffline(false);
          await run.report.check(
            `${label}: cached router offline screen automatically recovers`,
            () =>
              warm.page
                .getByRole("heading", { name: "Shared with me", exact: true })
                .waitFor({ timeout: 10000 }),
          );
        } finally {
          await warm.context.setOffline(false);
          await warm.context.close();
        }

        // A genuinely missing built asset while online, not an offline/network-error substitute.
        const stale = await ownerPage(run, options);
        const assets = join(run.web.publicDirectory, "assets");
        const shared = readdirSync(assets).find((name) => /^shared-screen-.*\.js$/.test(name));
        assert.ok(shared, "Shared screen chunk missing from build");
        const chunk = join(assets, shared);
        chmodSync(assets, 0o755);
        renameSync(chunk, `${chunk}.withheld`);

        try {
          await stale.page.getByRole("link", { name: "Shared", exact: true }).first().click();
          await run.report.check(`${label}: stale deployed chunk still offers Reload`, async () => {
            await stale.page
              .getByText("Your files aren’t affected. Reloading gets the latest version.")
              .waitFor();
            await stale.page.getByRole("button", { name: "Reload", exact: true }).waitFor();
            assert.equal(await stale.page.evaluate(() => navigator.onLine), true);
          });
          await run.report.shot(stale.page, `interface-stale-${label}`);
        } finally {
          renameSync(`${chunk}.withheld`, chunk);
          chmodSync(assets, 0o555);
          await stale.context.close();
        }
      });
    }
  }

  run.stack.sql(
    "UPDATE hyori_users SET name='Noor Haddad Al Mansouri, photographs and family archive administrator',email='noor.haddad.family.photographs.and.documents@archive-household.example.test' WHERE email='browser-review@example.test'",
  );

  for (const colorScheme of ["light", "dark"] as const) {
    const long = await ownerPage(run, { ...PHONE, colorScheme });

    try {
      await openUsers(long.page);

      const row = long.page
        .locator('[data-slot="item-table-row"]')
        .filter({ hasText: "archive-household" });

      await row.waitFor();
      await run.report.shot(long.page, `interface-long-identity-${colorScheme}`);
      await run.report.check(
        `phone-${colorScheme}: long identity gives way to badge and usage`,
        async () => {
          await readable(row, "Admin");
          await readable(row, "2.9 MB of 10 GB used");
          assert.equal(
            await long.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
        },
      );
      await long.page.goto(run.origin);

      for (const name of [
        `Family photographs from the autumn trip ${colorScheme}`,
        "Kyoto and the northern mountain villages",
        "Selections for the printed family archive",
      ])
        await folder(long.page, name);
      await run.report.shot(long.page, `interface-deep-path-${colorScheme}`);
      await run.report.check(
        `phone-${colorScheme}: deep path fits and immediate parent is tappable`,
        async () => {
          const path = long.page.getByRole("navigation", { name: "Folder path" });

          const parent = path.getByRole("link", {
            name: "Kyoto and the northern mountain villages",
            exact: true,
          });

          await parent.click({ timeout: 3000 });
          await long.page
            .getByRole("heading", { name: "Kyoto and the northern mountain villages", exact: true })
            .waitFor();
          assert.equal(
            await long.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            true,
          );
        },
      );
    } finally {
      await long.context.close();
    }
  }

  await runFailedPreloadChecks(run);
}

/** Warm code and data first; click-to-render excludes Playwright's actionability wait. */
async function warmNavigation(run: CoreRun) {
  const sections = [
    { name: "Files", path: "/", heading: "Files" },
    { name: "Photos", path: "/photos", heading: "Photos" },
    { name: "Albums", path: "/photos/albums", heading: "Photos" },
    { name: "Shared", path: "/shared", heading: "Shared with me" },
    { name: "Trash", path: "/trash", heading: "Trash" },
    { name: "Users", path: "/admin", heading: "Users" },
  ];

  for (const phone of [false, true]) {
    const label = phone ? "phone" : "desktop";
    const { context, page } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });

    async function destination(section: (typeof sections)[number]) {
      if (section.name === "Albums") {
        await page.getByRole("link", { name: "Photos", exact: true }).first().click();
        await page.getByRole("heading", { name: "Photos", exact: true }).waitFor();
      }

      if (section.name === "Users" && phone) {
        await page.getByRole("button", { name: "Account", exact: true }).press("Enter");

        return page.getByRole("menuitem", { name: "Users", exact: true });
      }

      return page.getByRole("link", { name: section.name, exact: true }).first();
    }

    try {
      for (const section of sections) {
        await (await destination(section)).click();
        await page.getByRole("heading", { name: section.heading, exact: true }).waitFor();
        await page.waitForLoadState("networkidle");
      }

      for (const section of sections) {
        await run.report.check(
          `${label}: warm navigation into ${section.name} stays under 250 ms`,
          async () => {
            const times: number[] = [];

            for (let repeat = 0; repeat < 10; repeat += 1) {
              const away = section.name === "Files" ? "Trash" : "Files";
              await page.getByRole("link", { name: away, exact: true }).first().click();
              await page.getByRole("heading", { name: away, exact: true }).waitFor();
              const target = await destination(section);

              const elapsed = await target.evaluate(
                (element, expected) =>
                  new Promise<number>((resolve, reject) => {
                    const deadline = setTimeout(
                      () => reject(new Error(`Warm ${expected.name} did not render`)),
                      2000,
                    );

                    const started = performance.now();

                    const rendered = () => {
                      const heading = [...document.querySelectorAll("h1")].some(
                        (node) => node.textContent === expected.heading,
                      );

                      if (location.pathname === expected.path && heading) {
                        clearTimeout(deadline);
                        resolve(performance.now() - started);
                      } else requestAnimationFrame(rendered);
                    };

                    if (!(element instanceof HTMLElement))
                      throw new Error("Expected a navigation control");

                    element.click();
                    requestAnimationFrame(rendered);
                  }),
                section,
              );

              times.push(elapsed);
            }

            run.report.observe(`${label}: warm ${section.name} click-to-render ms`, times);
            assert.ok(Math.max(...times) < 250, `${section.name}: ${times.join(", ")} ms`);
          },
        );
      }
    } finally {
      await context.close();
    }
  }
}

export async function runFailedPreloadChecks(run: CoreRun) {
  await run.report.scenario("Interface failed preloads", async () => {
    const seed = await ownerPage(run);
    await uploadFiles(seed.page, run.media.bytes("preload-letter.docx", 4096));
    await uploadsTray(seed.page).getByLabel("Uploaded").waitFor({ timeout: 30_000 });
    await seed.context.close();

    await run.report.check("editor preload that failed unseen costs the next open nothing", () =>
      failPreloadThenOpen(
        run,
        "editor",
        /\/assets\/editor-screen-[^/]+\.js$/,
        async (page) => {
          // The listed document starts the editor preload when the page goes idle.
          await page.reload();
        },
        async (page) => {
          const opened = page.waitForRequest(
            (request) => (request.postData() ?? "").includes('"editors.open"'),
            { timeout: 10_000 },
          );

          await page
            .getByRole("button", { name: /preload-letter\.docx/ })
            .first()
            .click();
          await opened;
        },
      ),
    );
    await run.report.check("section preload that failed unseen costs the next open nothing", () =>
      failPreloadThenOpen(
        run,
        "section",
        /\/assets\/trash-screen-[^/]+\.js$/,
        async (page) => {
          await page.getByRole("link", { name: "Trash", exact: true }).first().hover();
        },
        async (page) => {
          await page.getByRole("link", { name: "Trash", exact: true }).first().click();
          await page.getByRole("heading", { name: "Trash", exact: true }).waitFor();
        },
      ),
    );
  });
}

/**
 * A preload is a head start nobody sees. When it fails, for a dead spot on a phone or a 502 during a
 * deploy, and the network is healthy again by the click, the click must get the screen.
 */
async function failPreloadThenOpen(
  run: CoreRun,
  name: string,
  chunk: RegExp,
  preload: (page: Page) => Promise<void>,
  open: (page: Page) => Promise<void>,
) {
  const { context, page } = await ownerPage(run);
  let refused = 0;
  let requested = 0;

  try {
    // No editor bundle runs in this suite, so the server offers no editor. Only that list is
    // substituted, so documents are openable; the screen's code and the open itself are real.
    await context.addInitScript(() => {
      const fetchFromNetwork = window.fetch;

      window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetchFromNetwork(input, init);

        if (!String(init?.body ?? "").includes('"editors.available"')) return response;

        return new Response(
          (await response.text()).replace(
            '"apps":[]',
            '"apps":[{"app":"wordcraft","inputExtensions":[".docx"],"version":"test"}]',
          ),
          response,
        );
      }, fetchFromNetwork);
    });

    page.on("request", (request) => {
      if (chunk.test(new URL(request.url()).pathname)) requested += 1;
    });

    const preloadFailed = Promise.withResolvers<void>();

    const noPreload = setTimeout(
      () => preloadFailed.reject(new Error("No preload requested the screen's code.")),
      10_000,
    );

    await context.route(chunk, async (route) => {
      refused += 1;
      await route.abort("internetdisconnected");
      preloadFailed.resolve();
    });
    await preload(page);

    try {
      await preloadFailed.promise;
    } finally {
      clearTimeout(noPreload);
    }

    // Healthy again before the click, and the failed preload has settled in the app.
    await context.unroute(chunk);
    await page.waitForLoadState("networkidle");
    await open(page);
    assert.equal(refused, 1);
    assert.equal(requested, 2, "the open asks for the screen's code again");
    assert.equal(await page.getByText("Hyori couldn’t finish loading").count(), 0);
  } finally {
    await run.report.shot(page, `interface-failed-preload-${name}`);
    await context.close();
  }
}
