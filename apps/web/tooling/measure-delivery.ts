/** Run with Bun from the repository root. State contains credentials: keep it outside Git.
 * HYORI_DELIVERY_ORIGIN=https://… HYORI_DELIVERY_STATE=/private/state.json bun apps/web/tooling/measure-delivery.ts seed|measure output.json
 * Seed requires HYORI_SETUP_TOKEN on a fresh server. Measure never seeds or mutates product data.
 */
import { chromium } from "playwright-core";
import { createClient } from "@hyori-cloud/client-sdk";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { homedir, cpus, totalmem } from "node:os";
import { join, dirname } from "node:path";
import { z } from "zod";
import {
  observeDeliveryHydration,
  waitForDeliveryHydration as hydrated,
} from "./delivery-hydration.ts";

declare global {
  interface Window {
    deliveryLongTasks: number[];
    deliveryCsp: string[];
  }
}

const traceEvent = z.object({
  name: z.string(),
  ph: z.string(),
  ts: z.number(),
  dur: z.number().optional(),
  tid: z.number(),
  args: z.object({ name: z.unknown().optional() }).optional(),
});

function occupiedMs(intervals: [number, number][]) {
  let end = 0;
  let total = 0;

  for (const [start, finish] of intervals.sort((a, b) => a[0] - b[0])) {
    if (finish > end) {
      total += finish - Math.max(start, end);
      end = finish;
    }
  }

  return total;
}

const origin = new URL(process.env.HYORI_DELIVERY_ORIGIN!).origin;
const statePath = process.env.HYORI_DELIVERY_STATE ?? join(homedir(), "hyori-delivery/state.json");

const chrome =
  process.env.CHROME_PATH ?? join(homedir(), ".agent-browser/browsers/chrome-157.0.8103.78/chrome");

if (!origin) throw new Error("HYORI_DELIVERY_ORIGIN is required");

if (process.argv[2] === "seed") {
  const email = "delivery@example.test";
  const password = randomBytes(24).toString("hex");
  let cookie = "";

  const sdk = createClient({
    baseUrl: `${origin}/api/rpc`,
    fetch: async (input, init) => {
      const response = await fetch(input, {
        ...init,
        headers: { ...Object.fromEntries(new Headers(init?.headers)), origin, cookie },
      });

      if (response.headers.getSetCookie().length)
        cookie = response.headers
          .getSetCookie()
          .map((value) => value.split(";")[0])
          .join("; ");

      return response;
    },
  });

  try {
    await sdk.rpc.auth.setup({
      email,
      password,
      name: "Delivery Review",
      setupToken: process.env.HYORI_SETUP_TOKEN!,
    });
    const folder = await sdk.rpc.files.createFolder({ parentId: null, name: "Delivery files" });
    const pictures = await sdk.rpc.files.createFolder({ parentId: null, name: "Delivery photos" });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({ email, password, folderId: folder.id, picturesId: pictures.id }),
      { mode: 0o600 },
    );

    const imagePaths = process.env.HYORI_DELIVERY_IMAGES
      ? z.array(z.string()).min(1).parse(JSON.parse(process.env.HYORI_DELIVERY_IMAGES))
      : [process.env.HYORI_DELIVERY_IMAGE ?? "apps/server/tests/fixtures/media/red.png"];

    const images = await Promise.all(imagePaths.map((path) => readFile(path)));

    for (const [parentId, count, image] of [
      [folder.id, 1000, false],
      [pictures.id, 300, true],
    ] as const) {
      let next = 0;
      await Promise.all(
        Array.from({ length: 4 }, async () => {
          while (next < count) {
            const number = next++;
            const name = `${image ? "photo" : "document"}-${String(number).padStart(4, "0")}.${image ? "png" : "txt"}`;

            const task = sdk.uploads.start({
              parentId,
              file: new File(
                [image ? images[number % images.length]! : `Delivery sample ${number}\n`],
                name,
                {
                  type: image ? "image/png" : "text/plain",
                },
              ),
            });

            await task.result;
            task.dispose();
          }
        }),
      );
      console.log(`Seeded ${count} ${image ? "images" : "files"}`);
    }

    await sdk.rpc.photos.setSources({ allMyFiles: false, folderIds: [pictures.id] });
    const share = await sdk.rpc.shares.create({ itemId: folder.id, public: true, role: "viewer" });
    await mkdir(dirname(statePath), { recursive: true });
    await writeFile(
      statePath,
      JSON.stringify({
        email,
        password,
        folderId: folder.id,
        picturesId: pictures.id,
        shareUrl: share.url,
      }),
      { mode: 0o600 },
    );
  } finally {
    sdk.dispose();
  }
} else {
  const state = z
    .object({ email: z.string(), password: z.string(), folderId: z.string(), shareUrl: z.string() })
    .parse(JSON.parse(await readFile(statePath, "utf8")));

  const results: unknown[] = [];

  const redactPath = (url: string) =>
    new URL(url).pathname.replace(new URL(state.shareUrl, origin).pathname, "/s/[fixture-token]");

  const report = {
    hardware: {
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      totalMemory: totalmem(),
      platform: process.platform,
    },
    origin,
    profiles: {
      desktop: "1280x800, unthrottled",
      mobile: "390x844 touch Chromium, 4x CPU, 150ms RTT, 1.6Mbps down / 750kbps up",
    },
    results,
  };

  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  const authContext = await browser.newContext();
  let accountCookies;

  try {
    const page = await authContext.newPage();
    await page.goto(origin);
    await page.getByRole("button", { name: "Sign in", exact: true, disabled: false }).waitFor();
    await page.waitForLoadState("networkidle");
    await page.getByLabel("Email").fill(state.email);
    await page.getByLabel("Password", { exact: true }).fill(state.password);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByText("Delivery files", { exact: true }).waitFor();
    accountCookies = await authContext.cookies();
  } finally {
    await browser.close();
  }

  for (const mobile of [false, true]) {
    if (process.argv[4] && process.argv[4] !== (mobile ? "mobile" : "desktop")) continue;

    for (const screen of ["login", "files", "photos", "share", "admin"] as const) {
      if (process.argv[5] && process.argv[5] !== screen) continue;

      if (
        process.env.HYORI_DELIVERY_SCREENS &&
        !process.env.HYORI_DELIVERY_SCREENS.split(",").includes(screen)
      )
        continue;

      for (let run = 0; run < 3; run++) {
        const profile = join(
          dirname(statePath),
          `profile-${mobile}-${screen}-${run}-${Date.now()}`,
        );

        const context = await chromium.launchPersistentContext(profile, {
          executablePath: chrome,
          headless: true,
          viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
          deviceScaleFactor: 2,
          hasTouch: mobile,
          isMobile: mobile,
        });

        try {
          const page = context.pages()[0]!;

          if (screen !== "login" && screen !== "share") {
            await context.addCookies(accountCookies);
          }

          const session = await context.newCDPSession(page);
          await session.send("Network.enable");
          await session.send("Performance.enable");
          await session.send("Network.clearBrowserCache");

          if (mobile) {
            await session.send("Network.emulateNetworkConditions", {
              offline: false,
              latency: 150,
              downloadThroughput: 200_000,
              uploadThroughput: 93_750,
            });
            await session.send("Emulation.setCPUThrottlingRate", { rate: 4 });
          }

          await page.addInitScript(observeDeliveryHydration, "button");
          await page.addInitScript(() => {
            const tasks: number[] = [];

            Object.assign(window, {
              deliveryLongTasks: tasks,
              deliveryCsp: [],
            });
            new PerformanceObserver((list) =>
              tasks.push(...list.getEntries().map((entry) => entry.duration)),
            ).observe({ type: "longtask", buffered: true });
            document.addEventListener("securitypolicyviolation", (event) =>
              window.deliveryCsp.push(`${event.violatedDirective}:${event.blockedURI}`),
            );
          });

          const paths = {
            files: `/folders/${state.folderId}`,
            photos: "/photos",
            admin: "/admin",
            share: new URL(state.shareUrl, origin).pathname,
            login: "/",
          };

          const path = paths[screen];

          for (const cache of ["cold", "warm"]) {
            const waterfall: unknown[] = [];
            const requestPaths = new Map<string, string>();
            const networkResponses: { url: string; status: number }[] = [];

            const requestListener = (event: { requestId: string; request: { url: string } }) =>
              requestPaths.set(event.requestId, redactPath(event.request.url));

            const networkResponseListener = (event: { requestId: string; statusCode: number }) =>
              networkResponses.push({
                url: requestPaths.get(event.requestId) ?? "unknown",
                status: event.statusCode,
              });

            session.on("Network.requestWillBeSent", requestListener);
            session.on("Network.responseReceivedExtraInfo", networkResponseListener);
            const trace: z.infer<typeof traceEvent>[] = [];

            const traceListener = (event: { value: unknown[] }) =>
              trace.push(...z.array(traceEvent).parse(event.value));

            session.on("Tracing.dataCollected", traceListener);
            await session.send("Tracing.start", {
              categories: "devtools.timeline,v8",
              transferMode: "ReportEvents",
            });
            let wireBytes = 0;

            const finished = (event: { encodedDataLength: number }) => {
              wireBytes += event.encodedDataLength;
            };

            session.on("Network.loadingFinished", finished);

            const responseListener = async (response: import("playwright-core").Response) => {
              const request = response.request();
              const headers = await response.allHeaders();
              delete headers["set-cookie"];
              waterfall.push({
                url: redactPath(response.url()),
                operation: request.postDataJSON()?.operation,
                status: response.status(),
                timing: request.timing(),
                headers,
              });
            };

            page.on("response", responseListener);
            const errors: string[] = [];
            const errorListener = (error: Error) => errors.push(error.message);
            page.on("pageerror", errorListener);
            await page.goto(`${origin}${path}`, { waitUntil: "domcontentloaded" });

            if (screen === "login")
              await hydrated(
                page.getByRole("button", { name: "Sign in", exact: true, disabled: false }),
              );

            if (screen === "files")
              await hydrated(page.getByRole("button", { name: /^document-\d+\.txt/ }).first());

            if (screen === "photos")
              await page
                .getByRole("button", { name: /^photo-\d+\.png/ })
                .first()
                .waitFor();

            if (screen === "photos" && process.env.HYORI_DELIVERY_EXPECT_THUMBNAILS === "true") {
              const visibleLabels = await page
                .locator('button[aria-label^="photo-"]')
                .evaluateAll((tiles) =>
                  tiles
                    .filter((tile) => {
                      const rect = tile.getBoundingClientRect();
                      const x = rect.left + rect.width / 2;

                      // Respect the app's clipped scrolling viewport, not just the document bounds.
                      // Edge samples include a partially visible bottom row whose center is clipped.
                      return [rect.top + 1, rect.top + rect.height / 2, rect.bottom - 1].some(
                        (y) =>
                          y > 0 &&
                          y < innerHeight &&
                          tile.contains(document.elementFromPoint(x, y)),
                      );
                    })
                    .map((tile) => tile.getAttribute("aria-label")!),
                );

              if (!visibleLabels.length) throw new Error("No visible photo tiles");
              // Snapshot geometry once: repeatedly forcing layout would distort CPU measurements.
              await page.waitForFunction(
                (labels) =>
                  labels.every((label) => {
                    const image = document.querySelector<HTMLImageElement>(
                      `button[aria-label="${label}"] img[src*="/api/storage/derivatives/"]`,
                    );

                    return image?.complete && image.naturalWidth > 0;
                  }),
                visibleLabels,
                { polling: 100 },
              );
              await page.evaluate(
                (labels) =>
                  Promise.all(
                    labels.map((label) =>
                      document
                        .querySelector<HTMLImageElement>(
                          `button[aria-label="${label}"] img[src*="/api/storage/derivatives/"]`,
                        )!
                        .decode(),
                    ),
                  ).then(() => undefined),
                visibleLabels,
              );
            }

            if (screen === "share") {
              const gate = page.getByRole("button", { name: "Open shared item", exact: true });
              const firstFile = page.getByRole("button", { name: /^document-\d+\.txt/ }).first();

              const opened = await Promise.race([
                gate.waitFor().then(() => false),
                firstFile.waitFor().then(() => true),
              ]);

              if (!opened) {
                // The public consent button exists in SSR. Wait for the real hydrated control.
                await hydrated(gate);
                await gate.click();
              }

              await hydrated(firstFile);
            }

            if (screen === "admin")
              await hydrated(
                page.getByRole("button", { name: "Actions for Delivery Review", exact: true }),
              );
            const usableMs = await page.evaluate(() => performance.now());
            const metrics = await session.send("Performance.getMetrics");
            await page.waitForLoadState("networkidle");

            const tracingDone = new Promise<void>((resolve) =>
              session.once("Tracing.tracingComplete", () => resolve()),
            );

            await session.send("Tracing.end");
            await tracingDone;
            session.off("Tracing.dataCollected", traceListener);

            const performanceData = await page.evaluate(() => ({
              documentMs: performance
                .getEntriesByType("navigation")
                .filter((entry) => entry instanceof PerformanceNavigationTiming)[0]?.responseEnd,
              decodedThumbnails: [
                ...document.querySelectorAll<HTMLImageElement>(
                  'img[src*="/api/storage/derivatives/"]',
                ),
              ].filter((image) => image.complete && image.naturalWidth > 0).length,
              photoTiles: [
                ...document.querySelectorAll<HTMLElement>('[data-slot="media-tile"]'),
              ].map((tile) => {
                const rect = tile.getBoundingClientRect();
                const image = tile.querySelector<HTMLImageElement>("img");

                return {
                  id: tile.dataset.itemKey,
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height,
                  dpr: devicePixelRatio,
                  image: image?.getAttribute("src"),
                  naturalWidth: image?.naturalWidth,
                  naturalHeight: image?.naturalHeight,
                };
              }),
              resources: performance
                .getEntriesByType("resource")
                .filter((entry) => entry instanceof PerformanceResourceTiming)
                .map((resource) => ({
                  url: new URL(resource.name).pathname,
                  start: resource.startTime,
                  duration: resource.duration,
                  transfer: resource.transferSize,
                  decoded: resource.decodedBodySize,
                })),
              longTasks: window.deliveryLongTasks,
              csp: window.deliveryCsp,
            }));

            const navigationStart = metrics.metrics.find(
              (metric) => metric.name === "NavigationStart",
            )?.value;

            if (!navigationStart) throw new Error("Missing CDP navigation clock");

            const mainThreads = new Set(
              trace.flatMap((event) =>
                event.name === "thread_name" && event.args?.name === "CrRendererMain"
                  ? [event.tid]
                  : [],
              ),
            );

            const scriptMs = (names: RegExp) =>
              occupiedMs(
                trace.flatMap((event): [number, number][] => {
                  if (event.ph !== "X" || !mainThreads.has(event.tid) || !names.test(event.name))
                    return [];
                  const start = Math.max(0, event.ts / 1000 - navigationStart * 1000);

                  const end = Math.min(
                    usableMs,
                    (event.ts + (event.dur ?? 0)) / 1000 - navigationStart * 1000,
                  );

                  return end > start ? [[start, end]] : [];
                }),
              );

            const requestMs = (pattern: RegExp) =>
              occupiedMs(
                performanceData.resources.flatMap((resource): [number, number][] =>
                  pattern.test(resource.url) && resource.start < usableMs
                    ? [[resource.start, Math.min(usableMs, resource.start + resource.duration)]]
                    : [],
                ),
              );

            results.push({
              mobile,
              screen,
              run,
              cache,
              usableMs,
              wireBytes,
              errors,
              waterfall,
              networkResponses,
              ...performanceData,
              phases: {
                documentMs: performanceData.documentMs,
                jsFetchWallMs: requestMs(/\.js$/),
                jsParseCompileMainMs: scriptMs(
                  /^(v8\..*compile|V8.*Compile|CompileScript|CompileModule|ParseScript|ParseProgram)/i,
                ),
                jsEvaluateMainMs: scriptMs(/^(EvaluateScript|EvaluateModule|FunctionCall)$/),
                rpcWaitWallMs: requestMs(/^\/api\/rpc$/),
                rendererMainThreads: mainThreads.size,
              },
              resources: performanceData.resources.map((resource) => ({
                ...resource,
                url: resource.url.replace(
                  new URL(state.shareUrl, origin).pathname,
                  "/s/[fixture-token]",
                ),
              })),
            });
            await writeFile(process.argv[3]!, JSON.stringify(report, null, 2));

            if (process.env.HYORI_DELIVERY_CAPTURES && run === 0 && cache === "warm") {
              await mkdir(process.env.HYORI_DELIVERY_CAPTURES, { recursive: true });

              if (screen === "files")
                await page.waitForFunction(
                  () => document.querySelector('[data-slot="item-table-row"] div[title]') !== null,
                );

              await page.screenshot({
                path: join(
                  process.env.HYORI_DELIVERY_CAPTURES,
                  `${mobile ? "mobile" : "desktop"}-${screen}.png`,
                ),
              });
            }

            console.log(
              JSON.stringify({ mobile, screen, run, cache, usableMs, wireBytes, errors }),
            );
            page.off("response", responseListener);
            page.off("pageerror", errorListener);
            session.off("Network.loadingFinished", finished);
            session.off("Network.requestWillBeSent", requestListener);
            session.off("Network.responseReceivedExtraInfo", networkResponseListener);
          }
        } finally {
          await context.close();
          await rm(profile, { recursive: true, force: true });
        }
      }
    }
  }

  await writeFile(process.argv[3]!, JSON.stringify(report, null, 2));
}
