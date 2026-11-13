import assert from "node:assert/strict";
import { ownerPage, waitForHydration } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { PHONE } from "./scenarios-touch.ts";

declare global {
  interface Window {
    wrongSortFrames: number;
  }
}

const orders = [
  ["nameAsc", "Name, A to Z", "name", false],
  ["nameDesc", "Name, Z to A", "name", true],
  ["sizeAsc", "Size, smallest first", "size", false],
  ["sizeDesc", "Size, largest first", "size", true],
  ["modifiedAsc", "Modified, oldest first", "modified", false],
  ["modifiedDesc", "Modified, newest first", "modified", true],
] as const;

/** Metadata fixture deliberately reverses names relative to IDs and ties sizes and times. */
export async function runSortingScenarios(run: CoreRun, phone: boolean) {
  const size = phone ? "phone" : "desktop";
  const { page, context } = await ownerPage(run, phone ? PHONE : { deviceScaleFactor: 2 });
  const prefix = `browser-sort-${size}`;
  const parent = `${prefix}-parent`;

  try {
    run.stack.sql(`INSERT INTO hyori_items(id,owner_id,name,kind,mime_type)
      SELECT '${parent}',id,'Sorting ${size}','folder','inode/directory' FROM hyori_users WHERE email='noor@example.test';
      INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids,updated_at)
      SELECT '${prefix}-'||lpad(n::text,4,'0'),owner_id,'${parent}','Entry '||lpad((185-n)::text,4,'0'),
      CASE WHEN n<=7 THEN 'folder' ELSE 'file' END,CASE WHEN n<=7 THEN 0 ELSE n%13 END,
      'application/octet-stream',jsonb_build_array('${parent}'),'2020-01-01'::timestamptz+(n%5)*interval '1 day'
      FROM hyori_items CROSS JOIN generate_series(1,185) n WHERE id='${parent}';`);
    await page.goto(`${run.origin}/folders/${parent}`);
    await waitForHydration(page);
    const trigger = page.getByRole("combobox", { name: "Sort files" });

    const activate = async (control: ReturnType<typeof page.getByRole>) => {
      if (phone) await control.tap();
      else {
        await control.focus();
        await control.press("Enter");
      }
    };

    if (phone) assert(await page.evaluate(() => matchMedia("(pointer: coarse)").matches));

    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.waitForFunction(
        (dark) => document.documentElement.classList.contains("dark") === dark,
        theme === "dark",
      );

      for (const layout of ["List", "Grid"] as const) {
        // Start a fresh cache so each order exercises actual continuation, not retained full pages.
        await page.reload();
        await waitForHydration(page);
        await activate(page.getByRole("button", { name: layout, exact: true }));

        for (const [sort, label, key, descending] of orders) {
          await run.report.check(
            `${size} ${theme} ${layout}: ${label}, all 185 entries across two pages`,
            async () => {
              const expected = Array.from({ length: 185 }, (_, index) => {
                const n = index + 1;

                return {
                  id: `${prefix}-${String(n).padStart(4, "0")}`,
                  file: n > 7,
                  name: `Entry ${String(185 - n).padStart(4, "0")}`,
                  size: n <= 7 ? 0 : n % 13,
                  modified: n % 5,
                };
              }).sort((a, b) => {
                const folderName = key === "size" && !a.file && !b.file;

                const first = folderName ? a.name : a[key],
                  second = folderName ? b.name : b[key];

                const order =
                  (first < second ? -1 : first > second ? 1 : 0) || (a.id < b.id ? -1 : 1);

                return Number(a.file) - Number(b.file) || (descending ? -order : order);
              });

              await activate(trigger);
              await page.getByRole("option", { name: label, exact: true }).waitFor();
              await activate(page.getByRole("option", { name: label, exact: true }));
              await page.waitForFunction(
                (label) =>
                  document.querySelector('[aria-label="Sort files"]')?.getAttribute("title") ===
                  label,
                label,
              );
              await page.waitForFunction(
                () => document.querySelectorAll("[data-item-key]").length === 100,
              );
              // The selected label is not evidence that its page has finished loading.
              // Do not start continuation until the first page itself matches the chosen order.
              await page.waitForFunction(
                (ids) => {
                  const rows = [...document.querySelectorAll("[data-item-key]")];

                  return (
                    rows.length === ids.length &&
                    rows.every((row, index) => row.getAttribute("data-item-key") === ids[index])
                  );
                },
                expected.slice(0, 100).map((row) => row.id),
              );

              if (layout === "List" && sort === "nameAsc")
                await run.report.shot(page, `sorting-${size}-${theme}-default`);

              const more = page.getByRole("button", { name: "Load more", exact: true });

              // Let content-visibility measure the newly exposed tiles before touching the
              // continuation. Otherwise its first auto-scroll can move it during the tap.
              await more.scrollIntoViewIfNeeded();
              await page.evaluate(
                () =>
                  new Promise<void>((resolve) =>
                    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
                  ),
              );
              await activate(more);
              await page.waitForFunction(
                () => document.querySelectorAll("[data-item-key]").length === 185,
              );

              assert.deepEqual(
                await page
                  .locator("[data-item-key]")
                  .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-item-key"))),
                expected.map((row) => row.id),
              );

              if (layout === "List") {
                await trigger.scrollIntoViewIfNeeded();
                await activate(trigger);
                assert.equal(
                  await page
                    .getByRole("option", { name: label, exact: true })
                    .getAttribute("aria-selected"),
                  "true",
                );
                await run.report.shot(page, `sorting-${size}-${theme}-${sort}-selected`);
                await page.keyboard.press("Escape");
              }
            },
          );
        }
      }

      await trigger.scrollIntoViewIfNeeded();
      await run.report.shot(page, `sorting-${size}-${theme}-closed`);

      if (!phone) {
        await trigger.focus();
        assert(await trigger.evaluate((element) => element.matches(":focus-visible")));
        await run.report.shot(page, `sorting-${size}-${theme}-trigger-focus`);
        await trigger.press("ArrowDown");
        await page.getByRole("listbox").waitFor();
        await page.keyboard.press("Home");
        await page.waitForFunction(() => document.activeElement?.textContent === "Name, A to Z");
        await run.report.shot(page, `sorting-${size}-${theme}-keyboard-focus`);
        await run.report.check(
          `${size} ${theme}: keyboard navigation selects an order`,
          async () => {
            await page.keyboard.press("Home");
            await page.waitForFunction(
              () => document.activeElement?.textContent === "Name, A to Z",
            );
            await page.keyboard.press("Enter");
            await page.waitForFunction(
              () =>
                document.querySelector('[aria-label="Sort files"]')?.getAttribute("title") ===
                "Name, A to Z",
            );
            await page.getByRole("listbox").waitFor({ state: "hidden" });
            await trigger.focus();
            await trigger.press("ArrowDown");
            await page.getByRole("listbox").waitFor();
            await page.keyboard.press("End");
            await page.waitForFunction(
              () => document.activeElement?.textContent === "Modified, newest first",
            );
            await page.keyboard.press("Enter");
            await page.waitForFunction(
              () =>
                document.querySelector('[aria-label="Sort files"]')?.getAttribute("title") ===
                "Modified, newest first",
            );
            await page.getByRole("listbox").waitFor({ state: "hidden" });
          },
        );
      }
    }

    await run.report.check(
      `${size}: sort survives reload without a wrong first-frame order`,
      async () => {
        await page.addInitScript(() => {
          Object.assign(window, { wrongSortFrames: 0 });

          const observe = () => {
            const first = document.querySelector<HTMLElement>("[data-item-key]");

            if (
              first?.checkVisibility({ visibilityProperty: true }) &&
              first.dataset.itemKey !==
                `browser-sort-${innerWidth < 768 ? "phone" : "desktop"}-0004`
            ) {
              // Modified newest first: folders 4,3,2,7,1,6,5; ID descending within ties.
              window.wrongSortFrames++;
            }

            requestAnimationFrame(observe);
          };

          requestAnimationFrame(observe);
        });
        await page.reload();
        await page.waitForFunction(
          () => document.querySelectorAll("[data-item-key]").length === 100,
        );
        assert.equal(await trigger.getAttribute("title"), "Modified, newest first");
        assert.equal(await page.evaluate(() => window.wrongSortFrames), 0);
      },
    );
  } finally {
    await context.close();
  }
}
