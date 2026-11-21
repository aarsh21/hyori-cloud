import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { BrowserContext, BrowserContextOptions, Page } from "playwright-core";
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

/**
 * A caret move publishes presence on a debounce, and every collaboration receipt re-applies each
 * peer's awareness, which rebuilds the remote cursor widgets around the caret. A keystroke batch
 * dispatched into that rebuild can be dropped by the browser before any character reaches the
 * document. So before typing: wait out the presence debounce, then wait for two identical editor
 * snapshots and take the editor as quiet. Best effort — a runner slower than the timeout still
 * types, and the landing checks below catch a dropped batch.
 */
async function settle(page: Page) {
  const floor = Date.now() + 350;
  await page
    .waitForFunction(
      (until) => {
        const editor = document.querySelector(".bn-editor");

        if (!editor || Date.now() < until) return false;
        const markup = editor.innerHTML;
        const quiet = document.documentElement.dataset;

        if (quiet.hyoriEditorQuiet === markup) return true;
        quiet.hyoriEditorQuiet = markup;

        return false;
      },
      floor,
      { polling: 100, timeout: 3_000 },
    )
    .then(
      () => {},
      () => {},
    );
}

/**
 * Chrome can drop a whole batch keystroke while collaboration cursors re-render under the caret,
 * before any character reaches the document, and a dropped batch leaves no local trace to sync.
 * The product promise under test is that text which reaches an editor converges, so type, prove
 * the text reached this page and kept its place, and retype only when the input pipeline dropped
 * the batch. A retry must not re-anchor: clicking and pressing Home again restarts the cursor
 * churn that dropped the batch, so the caret is touched again only when focus actually left the
 * editor.
 */
async function typeUntilLanded(page: Page, text: string, anchor: () => Promise<void>) {
  for (let attempt = 0; ; attempt++) {
    await settle(page);
    await page.keyboard.insertText(text);

    const landed = await page
      .waitForFunction(
        (value) => document.querySelector(".bn-editor")?.textContent?.includes(value),
        text,
        { polling: 50, timeout: 1_000 },
      )
      .then(
        () => true,
        () => false,
      );

    if (landed) {
      const stayed = await page.evaluate(async (value) => {
        const deadline = Date.now() + 1_000;

        while (Date.now() < deadline) {
          if (!document.querySelector(".bn-editor")?.textContent?.includes(value)) return false;
          await new Promise((resolve) => setTimeout(resolve, 50));
        }

        return true;
      }, text);

      if (!stayed)
        assert.fail(
          `Typed "${text}" reached this page's editor but a later update removed it again`,
        );

      return;
    }

    assert.ok(attempt < 8, `Typing "${text}" never reached this page's editor`);

    const focused = await page.evaluate(
      () => document.activeElement?.classList.contains("bn-editor") ?? false,
    );

    if (!focused) await anchor();
  }
}

/**
 * One person's half of simultaneous editing. Batch insertions and IME compositions land in the
 * paragraph the other person is typing in, each right after a caret move, with no pause for the
 * other's presence or sync receipts to settle: exactly the input that collaboration cursors and
 * remote updates must never swallow. Nothing is retried. Each marker begins with a letter no other
 * marker uses, so the binding's text diff can only place it where it was typed. Returns the text
 * that must survive.
 */
async function typeAlongside(
  page: Page,
  context: BrowserContext,
  [batches, compositions]: readonly [string, string],
) {
  const cdp = await context.newCDPSession(page);
  const typed: string[] = [];

  await page.locator("p.bn-inline-content").first().click();

  for (let round = 0; round < batches.length; round++) {
    // Document edges, not Home/End: those follow visual lines, which wrap inside CJK words.
    await page.keyboard.press(round % 2 ? "Control+End" : "Control+Home");
    const batch = `${batches[round]}typed${round} `;
    await page.keyboard.insertText(batch);
    typed.push(batch);

    // The composition stays open across sync receipts and remote caret moves before it commits.
    for (const preview of ["に", "にほ", "にほん"]) {
      await cdp.send("Input.imeSetComposition", {
        text: preview,
        selectionStart: preview.length,
        selectionEnd: preview.length,
      });
      await page.waitForTimeout(90);
    }

    const composed = `${compositions[round]}語${round} `;
    await cdp.send("Input.insertText", { text: composed });
    typed.push(composed);
    await page.waitForTimeout((round * 70) % 300);
  }

  await cdp.detach();

  return typed;
}

async function append(page: Page, text: string) {
  const anchor = async () => {
    await page.locator("p.bn-inline-content").last().click();
    await page.keyboard.press("End");
  };

  await anchor();
  await typeUntilLanded(page, text, anchor);
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
      // The first note comes from the sidebar header's New note, the one control this flow
      // had before the empty state grew its own "Create a note".
      await owner
        .locator("header", { has: owner.getByRole("heading", { name: "Notes", exact: true }) })
        .getByRole("button", { name: "New note", exact: true })
        .click();
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
      [owner, peer].map((page) =>
        rpc<{ user: { id: string; name: string } }>(page, "auth.status", {}),
      ),
    );

    assert.notEqual(identities[0]!.user.id, identities[1]!.user.id);
    assert.equal(await owner.evaluate(() => matchMedia("(pointer: coarse)").matches), phone);

    if (recording) await Promise.all([pointer(owner), pointer(peer)]);

    // The note is "saved" once each session opens, but a slow runner can still be a beat away
    // from an editor that accepts input, and keystrokes typed into that gap vanish without a
    // trace. Each editor is proven interactive only when the other page renders the cursor it
    // publishes, so both collaboration channels are live before the first keystroke lands.
    await Promise.all(
      [owner, peer].map((page) => page.locator("p.bn-inline-content").first().click()),
    );
    // The owner waits for Leena's cursor by name; the peer proves it renders remote cursors, and
    // the owner's own upstream is proven by the first convergence.
    await Promise.all([
      owner
        .locator(".bn-collaboration-cursor__label", { hasText: "Leena Rao" })
        .first()
        .waitFor({ state: "attached" }),
      peer.locator(".bn-collaboration-cursor__caret").first().waitFor(),
    ]);

    await run.report.check(`${name}: two people typing at once lose no keystroke`, async () => {
      const markers = await Promise.all([
        typeAlongside(owner, ownerContext, ["ABCDEF", "甲乙丙丁戊己"]),
        typeAlongside(peer, peerContext, ["GHIJKL", "子丑寅卯辰巳"]),
      ]);

      await converged(owner, peer, markers.flat());
      await Promise.all([saved(owner), saved(peer)]);
      const text = await content(owner);

      for (const marker of markers.flat())
        assert.equal(text.split(marker).length - 1, 1, `"${marker}" was duplicated`);

      assert.equal(text.length, markers.flat().join("").length, `stray text remained: ${text}`);
      assert.ok(!/[にほん]/.test(text), `an IME preview was committed: ${text}`);
    });
    await run.report.check(`${name}: a reloaded page leaves the note at once`, async () => {
      const own = identities[0]!.user.name;

      await owner.reload();
      await saved(owner);
      await owner.locator("p.bn-inline-content").first().click();
      await owner
        .locator(".bn-collaboration-cursor__label", { hasText: "Leena Rao" })
        .first()
        .waitFor({ state: "attached" });

      // The reload tears the old page's socket down and the server clears its presence at once;
      // the reloaded page republishes presence when it rejoins. The owner rendering Leena's
      // cursor proves the join happened, but the peer's header can re-render a beat later under
      // load, so the continuity window would otherwise race the tail of that teardown. Wait for
      // the rejoin to reach the peer first: a new page that never reappears still fails below.
      await peer.waitForFunction(
        (name) => document.querySelector("header span[title]")?.getAttribute("title") === name,
        own,
        { polling: 100, timeout: 10_000 },
      );

      // Across several sync rounds, the peer must list the owner once and the owner must never
      // see a caret carrying their own name: the page before the reload is gone, not idle.
      const [peerLists, ownCursors] = await Promise.all([
        peer.evaluate(async () => {
          const seen = new Set<string>();

          for (const end = Date.now() + 3_000; Date.now() < end;) {
            seen.add(document.querySelector("header span[title]")?.getAttribute("title") ?? "");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          return [...seen];
        }),
        owner.evaluate(async (name) => {
          let count = 0;

          for (const end = Date.now() + 3_000; Date.now() < end;) {
            for (const label of document.querySelectorAll(".bn-collaboration-cursor__label"))
              if (label.textContent === name) count++;
            await new Promise((resolve) => setTimeout(resolve, 100));
          }

          return count;
        }, own),
      ]);

      assert.deepEqual(peerLists, [own], "the reloaded page stayed in the peer's list");
      assert.equal(ownCursors, 0, "the reloaded page left a cursor with the owner's name");
    });

    await run.report.check(`${name}: a peer's caret never blocks a click`, async () => {
      const caret = owner
        .locator(".hyori-note-cursor", { hasText: "Leena Rao" })
        .locator(".bn-collaboration-cursor__caret");

      // Move away and let the label's activity timeout lapse, so only hovering can show it again.
      await owner.mouse.move(5, 5);
      await owner.waitForTimeout(2_300);
      const box = (await caret.boundingBox())!;
      const [x, y] = [box.x + box.width / 2, box.y + box.height / 2];

      assert.equal(
        await owner.evaluate(
          ([x, y]) => document.elementFromPoint(x!, y!)?.closest(".bn-editor") !== null,
          [x, y],
        ),
        true,
        "a remote caret takes the pointer instead of the editor",
      );
      await owner.mouse.move(x, y, { steps: 4 });
      await owner
        .locator(".hyori-note-cursor[data-active]", { hasText: "Leena Rao" })
        .waitFor({ state: "attached", timeout: 1_000 });
    });

    for (let repeat = 1; repeat <= 3; repeat++) {
      await run.report.check(
        `${name} run ${repeat}: concurrent edits and selective undo`,
        async () => {
          await Promise.all(
            [owner, peer].map(async (page) => {
              await page.mouse.move(210, 120, { steps: 12 });
              await page.mouse.move(440, 180, { steps: 12 });
            }),
          );

          const anchorOn = (page: Page) => async () => {
            await page.locator("p.bn-inline-content").first().click();
            await page.keyboard.press("Home");
          };

          const a = `Noor-${repeat} `;
          const b = `Leena-${repeat} `;
          // One page types at a time: anchoring a caret republishes presence, which rebuilds the
          // remote cursor widgets in the other page's editor, and Chrome drops batch keystrokes
          // dispatched into that rebuild. Both carets anchor first, while the paragraph still has
          // its pre-edit geometry — a caret re-anchored after the other page's insert can land
          // inside that insert once the shorter lines rewrap — and then the inserts land one at
          // a time. Sequential typing still proves the concurrent promise: two live sessions
          // cross-sync every edit and undo stays per-author.
          const [anchorOwner, anchorPeer] = [anchorOn(owner), anchorOn(peer)];
          await Promise.all([anchorOwner(), anchorPeer()]);
          await typeUntilLanded(owner, a, anchorOwner);
          await converged(owner, peer, [a]);
          await typeUntilLanded(peer, b, anchorPeer);
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
          // The undo just republished presence; let the peer's cursor widget settle before the
          // continuous passage starts, so the first characters are not typed into its rebuild.
          await settle(owner);
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
          try {
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
                (record) =>
                  record.operation === "collaboration.sync" && record.outcome === "dropped",
              );

            assert.ok(dropped, "no committed acknowledgement was dropped");
            assert.equal(dropped.status, 200);
            assert.equal((await content(peer)).split(marker).length - 1, 1);
          } finally {
            // A failed check must not leave the owner offline or a reply-dropping fault armed:
            // the restart check below needs the owner online, and a leftover fault would eat the
            // next run's first sync acknowledgement.
            await ownerContext.setOffline(false);
            run.front.clearFaults();
          }
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
