import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BrowserContextOptions, Page } from "playwright-core";
import { freshContext, openPage, ownerPage } from "./scenarios-core.ts";
import type { CoreRun } from "./scenarios-core.ts";
import { signIn } from "./page-actions.ts";
import { PHONE } from "./scenarios-touch.ts";

async function rpc<T>(
  page: Page,
  operation: string,
  input: Record<string, string | number | boolean | null>,
): Promise<T> {
  return page.evaluate(
    async ({ operation, input }) => {
      const response = await fetch("/api/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation, input }),
      });

      const body = await response.json();

      if (!body.ok) throw new Error(`${operation}: ${JSON.stringify(body.error)}`);

      return body.value;
    },
    { operation, input },
  );
}

const saved = (page: Page) =>
  page.getByRole("status").filter({ hasText: "Saved to Hyori" }).waitFor();

function content(page: Page) {
  return page.locator(".bn-editor").evaluate((element) => {
    // SAFETY: cloneNode preserves this locator's Element node type.
    const copy = element.cloneNode(true) as Element;
    copy.querySelectorAll(".ProseMirror-widget").forEach((node) => node.remove());

    return copy.textContent ?? "";
  });
}

async function converged(owner: Page, peer: Page, markers: readonly string[]) {
  const deadline = Date.now() + 20_000;

  while (Date.now() < deadline) {
    const [a, b] = await Promise.all([content(owner), content(peer)]);

    if (a === b && markers.every((marker) => a.includes(marker))) return a;

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.fail(
    `Notes did not converge: ${JSON.stringify([await content(owner), await content(peer)])}`,
  );
}

async function append(page: Page, text: string) {
  await page.locator("p.bn-inline-content").last().click();
  await page.keyboard.press("End");
  await page.keyboard.insertText(text);
}

async function pointer(page: Page) {
  await page.evaluate(() => {
    const cursor = document.createElement("div");
    cursor.style.cssText =
      "position:fixed;pointer-events:none;z-index:9999;width:12px;height:12px;border-radius:50%;background:white;border:2px solid #181614;left:0;top:0";
    document.body.append(cursor);
    document.addEventListener("mousemove", (event) => {
      cursor.style.transform = `translate(${event.clientX}px,${event.clientY}px)`;
    });
  });
}

async function notesVariant(run: CoreRun, phone: boolean, dark: boolean) {
  const name = `notes-${phone ? "phone" : "desktop"}-${dark ? "dark" : "light"}`;
  const recording = !phone && !dark;

  const options: BrowserContextOptions = {
    ...(phone ? PHONE : { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 }),
    colorScheme: dark ? "dark" : "light",
  };

  if (recording)
    options.recordVideo = {
      dir: join(run.report.directory, "video"),
      size: { width: 1280, height: 800 },
    };
  const { context: ownerContext, page: owner } = await ownerPage(run, options);
  const peerContext = await freshContext(run, options);
  const viewerContext = await freshContext(run, options);

  try {
    await owner.goto(`${run.origin}/notes`);
    await owner.getByRole("textbox", { name: "Find a note" }).waitFor();
    await owner.getByText("Loading notes…", { exact: true }).waitFor({ state: "hidden" });
    await run.report.shot(owner, `${name}-list`);
    const password = `notes fixture ${randomBytes(16).toString("hex")}`;
    const email = `${name}@example.test`;

    const member = await rpc<{ id: string }>(owner, "admin.createUser", {
      email,
      name: "Leena Rao",
      password,
    });

    const created = await run.report.check(`${name}: create and rename through Notes`, async () => {
      await owner.getByRole("button", { name: "New note", exact: true }).click();
      await saved(owner);
      assert.match(new URL(owner.url()).pathname, /^\/notes\/[^/]+$/);
      await owner.getByRole("button", { name: "Note actions" }).click();
      await owner.getByRole("menuitem", { name: "Rename", exact: true }).click();
      await owner.getByRole("textbox", { name: "Note title" }).fill(`Release decisions ${name}`);
      await owner.getByRole("button", { name: "Rename", exact: true }).click();
      await owner
        .getByRole("heading", { name: `Release decisions ${name}`, exact: true })
        .waitFor();
    });

    assert.ok(created, "The Notes UI must create and rename before collaboration can be tested");
    const id = new URL(owner.url()).pathname.split("/").at(-1)!;

    await rpc(owner, "shares.create", {
      itemId: id,
      recipientId: member.id,
      public: false,
      role: "editor",
    });
    await owner.goto(`${run.origin}/notes/${id}`);
    await saved(owner);
    await run.report.shot(owner, `${name}-empty`);
    const peer = await openPage(run, peerContext);
    await signIn(peer, email, password);
    await peer.getByRole("navigation", { name: "Main" }).first().waitFor();
    await peer.goto(`${run.origin}/notes/${id}`);
    await saved(peer);

    const identities = await Promise.all(
      [owner, peer].map((page) => rpc<{ user: { id: string } }>(page, "auth.status", {})),
    );

    assert.notEqual(identities[0]!.user.id, identities[1]!.user.id);
    assert.equal(await owner.evaluate(() => matchMedia("(pointer: coarse)").matches), phone);

    if (recording) await Promise.all([pointer(owner), pointer(peer)]);

    for (let repeat = 1; repeat <= 3; repeat++) {
      await run.report.check(
        `${name} run ${repeat}: concurrent edits and selective undo`,
        async () => {
          await Promise.all(
            [owner, peer].map(async (page) => {
              await page.mouse.move(210, 120, { steps: 12 });
              await page.mouse.move(440, 180, { steps: 12 });
              await page.locator("p.bn-inline-content").first().click();
              await page.keyboard.press("Home");
            }),
          );
          const a = `Noor-${repeat} `;
          const b = `Leena-${repeat} `;
          await Promise.all([owner.keyboard.insertText(a), peer.keyboard.insertText(b)]);
          await converged(owner, peer, [a, b]);
          await Promise.all([saved(owner), saved(peer)]);
          await owner.locator("p.bn-inline-content").first().click();
          await owner.keyboard.press("Control+z");
          await owner.waitForFunction(
            (marker) => !document.querySelector(".bn-editor")?.textContent?.includes(marker),
            a,
          );
          const result = await converged(owner, peer, [b]);
          assert.ok(!result.includes(a), "undo removed a peer edit or left the owner's edit");
          let typingFinished = false;
          const marker = `Live-${repeat} `;
          await Promise.all([
            owner.keyboard
              .type(`${marker}${"continuous input without a pause ".repeat(3)}`, { delay: 40 })
              .then(() => {
                typingFinished = true;
              }),
            peer
              .waitForFunction(
                (text) => document.querySelector(".bn-editor")?.textContent?.includes(text),
                marker,
              )
              .then(() => {
                assert.equal(typingFinished, false, "continuous typing postponed synchronization");
              }),
          ]);
          await converged(owner, peer, [marker]);
          await Promise.all([saved(owner), saved(peer)]);
        },
      );
      await run.report.check(
        `${name} run ${repeat}: offline merge and lost acknowledgement`,
        async () => {
          await ownerContext.setOffline(true);
          const a = `Offline-${repeat} `;
          const b = `Online-${repeat} `;
          await append(owner, a);
          await owner.getByText("Working offline", { exact: true }).waitFor();

          if (repeat === 1) await run.report.shot(owner, `${name}-offline`);
          await append(peer, b);
          await saved(peer);
          await ownerContext.setOffline(false);
          await converged(owner, peer, [a, b]);
          await saved(owner);
          const start = run.front.records.length;
          run.front.dropReply(
            (record) =>
              record.operation === "collaboration.sync" &&
              Boolean(JSON.parse(record.rpcBody ?? "{}").input?.update),
          );
          const marker = `Lost-receipt-${repeat} `;
          await append(owner, marker);
          await converged(owner, peer, [marker]);
          await saved(owner);

          const dropped = run.front.records
            .slice(start)
            .find(
              (record) => record.operation === "collaboration.sync" && record.outcome === "dropped",
            );

          assert.ok(dropped, "no committed acknowledgement was dropped");
          assert.equal(dropped.status, 200);
          assert.equal((await content(peer)).split(marker).length - 1, 1);
        },
      );
      await run.report.check(
        `${name} run ${repeat}: restart persistence and restore fence`,
        async () => {
          await Promise.all([saved(owner), saved(peer)]);
          const before = await content(owner);
          await run.stack.restartServer();
          await owner.reload();
          await saved(owner);
          assert.equal(await content(owner), before);
          const checkpoint = await rpc<{ id: string }>(owner, "notes.checkpoint", { id });
          await append(peer, `Replaced-${repeat} `);
          await converged(owner, peer, [`Replaced-${repeat} `]);
          await rpc(owner, "notes.restoreCheckpoint", { id, checkpointId: checkpoint.id });
          await Promise.all(
            [owner, peer].map((page) =>
              page.getByText("Editing paused", { exact: true }).waitFor(),
            ),
          );

          if (repeat === 1) await run.report.shot(owner, `${name}-paused`);

          for (const page of [owner, peer]) {
            await page.getByRole("button", { name: "Open latest version", exact: true }).click();
            await saved(page);
          }

          assert.equal(await content(owner), before);
          assert.equal(await content(peer), before);
        },
      );
    }

    await run.report.check(`${name}: pasted HTML is inert for the next reader`, async () => {
      await owner.locator("p.bn-inline-content").last().click();
      await owner.keyboard.press("End");
      await owner.locator(".bn-editor").evaluate((element) => {
        const clipboardData = new DataTransfer();
        clipboardData.setData(
          "text/html",
          '<p onclick="window.notesAttack=1">Pasted safety <a href="javascript:window.notesAttack=2">unsafe link</a> <a href="https://example.test/notes-safe-link" target="_top" class="fixed inset-0 z-50" onclick="window.notesAttack=5">Safe destination</a><script>window.notesAttack=3</script><img src="x" onerror="window.notesAttack=4"></p>',
        );
        clipboardData.setData("text/plain", "Pasted safety unsafe link Safe destination");
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
        );
      });
      await converged(owner, peer, ["Pasted safety"]);
      await saved(owner);
      await peer.reload();
      await saved(peer);
      assert.ok((await content(peer)).includes("Pasted safety"));
      assert.equal(
        await peer
          .locator(
            '.bn-editor script, .bn-editor iframe, .bn-editor [onclick], .bn-editor [onerror], .bn-editor a[href^="javascript:"], .bn-editor a[href^="data:"]',
          )
          .count(),
        0,
      );
      assert.equal(await peer.evaluate(() => "notesAttack" in window), false);
      const link = peer.locator('.bn-editor a[href="https://example.test/notes-safe-link"]');

      assert.equal(await link.getAttribute("target"), "_blank");
      assert.match((await link.getAttribute("rel")) ?? "", /noopener/);
      assert.ok(!(await link.getAttribute("class"))?.split(" ").includes("fixed"));
      assert.equal(new URL(peer.url()).pathname, `/notes/${id}`);
      // Intercept only the external destination; storing and rendering the link use the real stack.
      await peerContext.route("https://example.test/**", (route) =>
        route.fulfill({ contentType: "text/html", body: "<p>Allowed link destination</p>" }),
      );
      const opened = peer.waitForEvent("popup");

      await link.click();
      const popup = await opened;

      await popup.waitForURL("https://example.test/notes-safe-link");
      await popup.close();
      assert.equal(new URL(peer.url()).pathname, `/notes/${id}`);
    });
    await run.report.shot(owner, `${name}-open`);
    await run.report.check(`${name}: viewer cannot edit and layout fits`, async () => {
      const link = await rpc<{ url: string }>(owner, "shares.create", {
        itemId: id,
        public: true,
        role: "viewer",
      });

      const viewer = await openPage(run, viewerContext, new URL(link.url).pathname);
      await viewer.getByRole("button", { name: "Open" }).click();
      await saved(viewer);
      assert.equal(await viewer.locator(".bn-editor").getAttribute("contenteditable"), "false");
      assert.equal(
        await owner.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      await run.report.shot(viewer, `${name}-readonly`);
    });
    await owner.goto(`${run.origin}/notes`);
    await owner
      .getByRole("navigation", { name: "All notes" })
      .getByRole("link", { name: `Release decisions ${name}`, exact: true })
      .waitFor();
    await run.report.shot(owner, `${name}-list-populated`);
    await run.report.check(
      `${name}: a full note explains the limit and retry recovers`,
      async () => {
        // Full-page reloads above can leave leases until their idle expiry. Close those
        // through the normal API so the per-account cap does not preempt this note-cap case.
        const abandoned: string[] = JSON.parse(
          run.stack.sql(
            `SELECT COALESCE(json_agg(id),'[]') FROM hyori_collab_sessions WHERE principal='user:${identities[0]!.user.id}'`,
          ),
        );

        console.log(`  Capacity fixture: closing ${abandoned.length} earlier owner leases`);

        for (const sessionId of abandoned) {
          await rpc(owner, "collaboration.close", { sessionId });
        }

        const full = await rpc<{ file: { id: string } }>(owner, "notes.create", {
          parentId: null,
          name: `Full note ${name}`,
        });

        const rooms: string[] = [];

        try {
          for (let index = 0; index < 16; index++) {
            const room = await rpc<{ sessionId: string }>(owner, "collaboration.open", {
              id: full.file.id,
              clientId: String(10000 + index),
              schemaVersion: 1,
            });

            rooms.push(room.sessionId);
          }

          await owner.goto(`${run.origin}/notes/${full.file.id}`);
          await owner
            .getByText("This note is full. Try again in a moment.", {
              exact: true,
            })
            .waitFor();
          assert.equal(await owner.locator('[data-slot="spinner"]').count(), 0);
          assert.equal(
            await owner.getByRole("button", { name: "Export my work", exact: true }).count(),
            0,
          );
          await run.report.shot(owner, `${name}-full`);
          await rpc(owner, "collaboration.close", { sessionId: rooms.pop()! });
          await owner.getByRole("button", { name: "Try again", exact: true }).click();
          await saved(owner);
          assert.equal(await owner.locator(".bn-editor").getAttribute("contenteditable"), "true");
        } finally {
          for (const sessionId of rooms) await rpc(owner, "collaboration.close", { sessionId });
        }
      },
    );

    await run.report.check(
      `${name}: a trashed note leaves the list at once, with no refresh failure`,
      async () => {
        const title = `Trash me ${name}`;

        const doomed = await rpc<{ file: { id: string } }>(owner, "notes.create", {
          parentId: null,
          name: title,
        });

        await owner.goto(`${run.origin}/notes/${doomed.file.id}`);
        await saved(owner);
        // A refresh failure is an alert. Record one that renders even for a single frame.
        await owner.evaluate(() => {
          new MutationObserver(() => {
            for (const alert of document.querySelectorAll('[role="alert"]')) {
              if (alert.textContent?.includes("This may be out of date"))
                document.documentElement.dataset.refreshFailure = "shown";
            }
          }).observe(document.body, { childList: true, subtree: true, characterData: true });
        });
        await owner.getByRole("button", { name: "Note actions" }).click();
        await owner.getByRole("menuitem", { name: "Move to Trash", exact: true }).click();
        await owner
          .getByRole("dialog")
          .getByRole("button", { name: "Move to Trash", exact: true })
          .click();
        await owner.waitForURL(`${run.origin}/notes`);
        // The list also polls every 10 seconds; the declared invalidation must act well before that.
        await owner
          .getByRole("link", { name: title, exact: true })
          .waitFor({ state: "detached", timeout: 3000 });
        assert.equal(
          await owner.evaluate(() => document.documentElement.dataset.refreshFailure),
          undefined,
        );
      },
    );
  } finally {
    await Promise.all([ownerContext.close(), peerContext.close(), viewerContext.close()]);
  }
}

/** Full real-browser suite, including distinct account cookies, transport faults and process restart. */
export async function runNotesScenarios(run: CoreRun) {
  for (const phone of [false, true]) {
    for (const dark of [false, true]) {
      await run.report.scenario(
        `Notes ${phone ? "touch phone" : "desktop"} ${dark ? "dark" : "light"}`,
        () => notesVariant(run, phone, dark),
      );
    }
  }
}
