import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { FrontHandler } from "./front-proxy.ts";
import type { MediaKit } from "./media.ts";
import { fetchInPage, setupAdmin, signIn } from "./page-actions.ts";
import type { RunReport } from "./run-report.ts";
import type { EditorBundle } from "./editor-bundle.ts";
import type { RustStack } from "./rust-stack.ts";

export type CoreRun = {
  readonly report: RunReport;
  readonly browser: Browser;
  readonly origin: string;
  readonly stack: RustStack;
  /** The verified runtime bundle mounted for this run, if any. */
  readonly editorBundle: EditorBundle | null;
  /** The isolated media worker's image, or null for a backend from before thumbnails. */
  readonly worker: string | null;
  readonly front: FrontHandler;
  readonly media: MediaKit;
  readonly contextOptions?: Parameters<Browser["newContext"]>[0];
  readonly web: { readonly publicDirectory: string; readonly backendUrl: string };
};

export const OWNER = {
  email: "noor@example.test",
  password: `fixture ${randomBytes(12).toString("hex")} words`,
};

/** Fresh and isolated every time. The browser trusts only this run's key: see `chromiumTrustFor`. */
export async function freshContext(
  run: CoreRun,
  options: Parameters<Browser["newContext"]>[0] = {},
) {
  const context = await run.browser.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: true,
    ...run.contextOptions,
    ...options,
  });

  context.setDefaultTimeout(15_000);

  return context;
}

export async function openPage(run: CoreRun, context: BrowserContext, path = "/") {
  const page = await context.newPage();

  run.report.watch(page);
  await page.goto(`${run.origin}${path}`, { waitUntil: "domcontentloaded" });
  await waitForHydration(page);

  return page;
}

/** SSR makes controls visible before React attaches their behavior. Fixtures need the latter. */
export function waitForHydration(page: Page) {
  return page.waitForFunction(() => {
    const controls = [...document.querySelectorAll("button:not(:disabled),a[href]")].filter(
      (element) => element.getClientRects().length > 0,
    );

    return (
      controls.length > 0 &&
      controls.every((element) =>
        Object.keys(element).some((key) => key.startsWith("__reactFiber$")),
      )
    );
  });
}

/** The loopback address this fixture uses, and the one the web host was given: they can differ. */
const privateBackendHosts = ({ stack, web }: CoreRun) => [
  new URL(stack.backendUrl).host,
  new URL(web.backendUrl).host,
];

async function authScenario(run: CoreRun) {
  const { report, origin, stack, front } = run;
  const context = await freshContext(run);
  const page = await openPage(run, context);

  await report.check("a fresh server asks for setup", () =>
    page.getByRole("heading", { name: "Set up this server" }).waitFor(),
  );
  await report.shot(
    page,
    run.contextOptions?.isMobile ? "setup-phone-light" : "setup-desktop-light",
  );

  await report.check("a wrong setup token is refused, keeping what was typed", async () => {
    await setupAdmin(page, {
      token: "not-the-token",
      email: OWNER.email,
      password: OWNER.password,
    });
    await page.getByText("That setup token wasn’t accepted").waitFor();
    assert.deepEqual(
      await page.getByLabel("Email").inputValue(),
      OWNER.email,
      "email after failure",
    );
  });

  await report.check("setup creates the admin and opens Files", async () => {
    await setupAdmin(page, {
      token: stack.setupToken,
      email: OWNER.email,
      password: OWNER.password,
    });
    await page.getByText("No files yet").waitFor();
  });

  await report.check("session cookies are Secure and HttpOnly", async () => {
    const cookies = await context.cookies(origin);

    assert.ok(cookies.length > 0, "no cookies were set");

    for (const cookie of cookies) {
      assert.ok(cookie.secure, `${cookie.name} isn't Secure`);
      assert.ok(cookie.httpOnly, `${cookie.name} isn't HttpOnly`);
    }
  });

  await report.check("no public asset names the private backend", () => {
    const needles = privateBackendHosts(run);

    for (const entry of readdirSync(run.web.publicDirectory, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;

      const content = readFileSync(join(entry.parentPath, entry.name), "utf8");

      for (const needle of needles) {
        assert.ok(!content.includes(needle), `${entry.name} has the backend's address`);
      }

      assert.ok(!content.includes("HYORI_BACKEND_URL"), `${entry.name} names the setting`);
    }
  });

  await report.check("product traffic reached the backend through the web host", () => {
    const attempts = front.records.filter((record) => record.operation === "auth.setup");

    assert.deepEqual(attempts.map((record) => record.status).at(-1), 200, "last auth.setup status");
  });

  await report.check(
    "signing out returns to sign-in, and a wrong password stays there",
    async () => {
      await page
        .getByRole("button", { name: run.contextOptions?.isMobile ? "Account" : /Noor Haddad/ })
        .click();
      await page.getByRole("menuitem", { name: "Sign out" }).click();
      await page.getByRole("heading", { name: "Sign in" }).waitFor();
      await signIn(page, OWNER.email, "definitely wrong password");
      await page.getByText("That email and password don’t match").waitFor();
    },
  );

  await report.check("the server-rendered document has no failed Suspense boundary", async () => {
    const { status, text: html } = await fetchInPage(page, origin);
    const body = html.slice(html.indexOf("</head>"));

    report.observe("server-rendered document", {
      status,
      bytes: html.length,
      failedBoundaries: (body.match(/<!--\$!/g) ?? []).length,
      pendingBoundaries: (body.match(/<!--\$\?/g) ?? []).length,
      completeBoundaries: (body.match(/<!--\$-->/g) ?? []).length,
      sample: body.replace(/<script[\s\S]*?<\/script>/g, "").slice(0, 200),
    });
    assert.equal((body.match(/<!--\$!/g) ?? []).length, 0);

    for (const needle of privateBackendHosts(run)) {
      assert.ok(!html.includes(needle), "the backend's address is in the page");
    }

    assert.ok(!html.includes("HYORI_BACKEND_URL"), "the backend's setting is in the page");
  });

  await report.check("signing in works and reload keeps the session", async () => {
    await signIn(page, OWNER.email, OWNER.password);
    await page.getByText("No files yet").waitFor();
    await page.reload();
    await page.getByText("No files yet").waitFor();
  });

  ownerSession = await context.storageState();
  await context.close();
}

let ownerSession: Awaited<ReturnType<BrowserContext["storageState"]>> | undefined;

/** A fresh context holding only the owner's session cookies, so nothing else carries over. */
export async function ownerPage(run: CoreRun, options: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await freshContext(run, { ...options, storageState: ownerSession });
  const page = await openPage(run, context);

  await page.getByRole("navigation", { name: "Main" }).first().waitFor();

  return { context, page };
}

export async function runAuthScenario(run: CoreRun) {
  await run.report.scenario("Setup and sign-in", () => authScenario(run));
}
