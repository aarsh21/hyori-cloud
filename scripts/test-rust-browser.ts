import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { createServer } from "node:net";
import { createFrontHandler, serveHttp1, serveHttp2 } from "./browser-fixtures/front-proxy.ts";
import { createMediaKit } from "./browser-fixtures/media.ts";
import { createRunReport } from "./browser-fixtures/run-report.ts";
import { startNativeRustStack } from "./browser-fixtures/native-stack.ts";
import { startRustStack } from "./browser-fixtures/rust-stack.ts";
import { startHostNetworkLog, summarizeHostNetwork } from "./browser-fixtures/host-network-log.ts";
import { runAdminScenarios } from "./browser-fixtures/scenarios-admin.ts";
import { runConcurrentUploadScenario } from "./browser-fixtures/scenarios-concurrency.ts";
import { runAuthScenario } from "./browser-fixtures/scenarios-core.ts";
import { readEditorBundle } from "./browser-fixtures/editor-bundle.ts";
import { runEditorScenarios } from "./browser-fixtures/scenarios-editors.ts";
import { runDerivativeScenarios } from "./browser-fixtures/scenarios-derivatives.ts";
import { runFileScenarios } from "./browser-fixtures/scenarios-files.ts";
import { runSortingScenarios } from "./browser-fixtures/scenarios-sorting.ts";
import { runPhotoScenarios } from "./browser-fixtures/scenarios-photos.ts";
import { runNotesScenarios } from "./browser-fixtures/scenarios-notes.ts";
import {
  runDownloadSoak,
  runReplacementScenarios,
} from "./browser-fixtures/scenarios-replacement.ts";
import { runSharingScenarios } from "./browser-fixtures/scenarios-sharing.ts";
import { runThumbnailLatencyObservation } from "./browser-fixtures/scenarios-thumbnail-latency.ts";
import { runThumbnailStateScenario } from "./browser-fixtures/scenarios-thumbnails.ts";
import { PHONE, runTouchScenarios } from "./browser-fixtures/scenarios-touch.ts";
import {
  runReadinessScenarios,
  runResumeScenarios,
} from "./browser-fixtures/scenarios-readiness.ts";
import { runScreenScenarios } from "./browser-fixtures/scenarios-screens.ts";
import { runInterfaceScenarios } from "./browser-fixtures/scenarios-interface.ts";
import { runAccountScenarios } from "./browser-fixtures/scenarios-account.ts";
import { runPhoneCompletionScenarios } from "./browser-fixtures/scenarios-phone-completion.ts";
import { runTrayReachScenarios } from "./browser-fixtures/scenarios-tray-reach.ts";
import {
  chromiumTrustFor,
  createDisposableTls,
  EDITOR_RENDERING_ARGS,
  frontendIdentity,
  startBuiltWeb,
} from "./browser-fixtures/web-host.ts";
import { createWebImageHost } from "./browser-fixtures/web-image-host.ts";

/**
 * Real browser, TLS gateway, built Nitro host, its backend adapter, Rust release image, PostgreSQL,
 * and RustFS. Disposable and loopback-only, so it's never a deliverable in itself.
 *
 *   bun scripts/test-rust-browser.ts <image> [--protocol=http1|h2] [--worker=<image>] [--quiet-preflight=<seconds>] [--scenarios=a,b] [--no-build] [--fresh-image] [--artifacts=<new dir>]
 *     [--web-image=<image>] Run that exact image in its own container on this stack's private network,
 *       instead of this checkout's build on this host's Node.
 *     [--editor-bundle=<dir> --editor-bundle-sha256=<manifest sha>] Mount a verified editor bundle,
 *       which `--scenarios=editors` needs. Without it, every editor check reads as unverified.
 *     [--failure-screenshots=false] Never capture an unexpected failed state; explicit document shots remain.
 *     [--native] For hosts without containers: <image> is a `hyori-server` binary, run with native
 *       PostgreSQL 17 (`HYORI_POSTGRES_BIN`) and RustFS (`HYORI_RUSTFS_BIN`). No media worker.
 */
const image = process.argv[2];

if (image === undefined || image.startsWith("--")) throw new Error("Pass a Rust server image tag.");

const flags = process.argv.slice(3);

const flag = (name: string) => flags.find((value) => value.startsWith(`--${name}=`))?.split("=")[1];

const protocol = flag("protocol") ?? "http1";
const only = flag("scenarios")?.split(",");
const worker = flag("worker") ?? null;
const webImage = flag("web-image") ?? null;
const editorBundleDirectory = flag("editor-bundle");
const editorBundleSha256 = flag("editor-bundle-sha256");
const failureScreenshots = flag("failure-screenshots") ?? "true";

if (failureScreenshots !== "true" && failureScreenshots !== "false")
  throw new Error("failure-screenshots must be true or false");

if ((editorBundleDirectory === undefined) !== (editorBundleSha256 === undefined)) {
  throw new Error("Pass the editor bundle together with its manifest's SHA-256.");
}

// Before anything starts: a bundle that isn't the pinned one must not cost a run.
const editorBundle =
  editorBundleDirectory !== undefined && editorBundleSha256 !== undefined
    ? readEditorBundle(editorBundleDirectory, editorBundleSha256)
    : null;

// Only a backend built with server-owned preview revisions and admin parity may run those checks.

const freshImage = flags.includes("--fresh-image");
const native = flags.includes("--native");

if (native && (worker !== null || webImage !== null))
  throw new Error(
    "--native runs without containers, so it takes neither --worker nor --web-image.",
  );

const artifacts = flag("artifacts") ?? mkdtempSync(join(tmpdir(), "hyori-browser-artifacts-"));
const work = mkdtempSync(join(tmpdir(), "hyori-browser-work-"));
const cleanups: (() => void)[] = [() => rmSync(work, { recursive: true, force: true })];

function cleanup() {
  for (const dispose of cleanups.splice(0).reverse()) {
    try {
      dispose();
    } catch (error) {
      console.error("Cleanup step failed:", error);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

const quietPreflight = flag("quiet-preflight");

// Host interface changes fail Chromium's requests, so a run on a churning host proves little.
if (quietPreflight !== undefined) {
  const preflight = startHostNetworkLog();

  await new Promise((resolve) => setTimeout(resolve, Number(quietPreflight) * 1000));
  preflight.stop();

  if (preflight.events.length > 0) {
    console.error(
      `Not starting: ${preflight.events.length} host network events in ${quietPreflight}s.`,
    );
    cleanup();
    process.exit(3);
  }

  console.log(`Host network quiet for ${quietPreflight}s.`);
}

// Below the range Docker and the kernel hand out, so a container published later can't take it.
function fixturePort(): Promise<number> {
  const port = 20_000 + Math.floor(Math.random() * 10_000);

  return new Promise((resolve) => {
    const probe = createServer();

    probe.once("error", () => resolve(fixturePort()));
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve(port)));
  });
}

const report = createRunReport(artifacts, { captureFailures: failureScreenshots === "true" });
let failed = 1;

try {
  const port = await fixturePort();
  const origin = `https://localhost:${port}`;
  const tls = createDisposableTls("localhost");

  cleanups.push(tls.dispose);

  console.log("Starting the private stack.");

  const backendPort = await fixturePort();
  // From before the stack starts, so waiting to settle includes the changes it causes itself.
  const hostNetwork = startHostNetworkLog();

  cleanups.push(hostNetwork.stop);

  const stack = native
    ? await startNativeRustStack(
        {
          server: image,
          rustfs: process.env.HYORI_RUSTFS_BIN ?? "rustfs",
          postgresBin: process.env.HYORI_POSTGRES_BIN ?? "/usr/lib/postgresql/17/bin",
          logFile: join(artifacts, "native-stack.log"),
        },
        origin,
        backendPort,
        await fixturePort(),
        await fixturePort(),
        editorBundle,
      )
    : await startRustStack(image, origin, backendPort, worker, editorBundle);

  cleanups.push(stack.stop);
  cleanups.push(() => writeFileSync(join(artifacts, "backend.log"), stack.serverLogs()));

  async function startWeb() {
    if (webImage === null) {
      console.log("Building and starting the real frontend.");

      return startBuiltWeb({
        origin,
        backendUrl: stack.backendUrl,
        build: !flags.includes("--no-build"),
      });
    }

    console.log(`Starting ${webImage} in its own container.`);

    const host = createWebImageHost({ image: webImage, origin, backend: stack.webBackend });

    // Before anything exists: the fixture's network can't be removed while this is still on it.
    cleanups.push(host.stop);

    return host.start();
  }

  const web = await startWeb();

  cleanups.push(web.stop);

  const front = createFrontHandler({
    nitroUrl: web.url,
    staticRoot: editorBundle?.directory ?? null,
  });

  cleanups.push(
    protocol === "h2" ? serveHttp2(front, port, origin, tls) : serveHttp1(front, port, tls),
  );

  // Waited for, not assumed: if the host never settles, this run says so rather than failing oddly.
  const settled = await hostNetwork.settle(5000, 60_000);

  console.log(settled ? "Host network settled." : "Host network still changing after 60s.");

  const browserStartedAt = Date.now();

  // Trusts this run's key and no other, so every other certificate check stays on.
  const browser = await chromium.launch({
    headless: true,
    timeout: 30_000,
    executablePath: process.env.HYORI_CHROMIUM_PATH,
    args: [chromiumTrustFor(tls.cert), ...(editorBundle === null ? [] : EDITOR_RENDERING_ARGS)],
  });

  cleanups.push(() => void browser.close());
  console.log(`Chromium ${browser.version()} over ${protocol}`);

  const media = createMediaKit(join(work, "media"));

  const run = {
    report,
    browser,
    origin,
    stack,
    editorBundle,
    worker,
    front,
    media,
    web,
    // Own fresh server so first-run setup, logout and login also execute on a coarse pointer.
    contextOptions: only?.includes("phone-auth") ? PHONE : undefined,
  };

  // Setup comes first because everything else signs in to the account it creates.
  await runAuthScenario(run);

  const selected = (name: string) => only === undefined || only.includes(name);

  if (selected("files")) await runFileScenarios(run);

  if (only?.includes("sorting")) {
    for (const phone of [false, true])
      await report.scenario(`File sorting: ${phone ? "phone" : "desktop"}`, () =>
        runSortingScenarios(run, phone),
      );
  }

  if (selected("replacement")) await runReplacementScenarios(run);

  if (selected("sharing")) await runSharingScenarios(run);

  if (only?.includes("notes")) await runNotesScenarios(run);

  if (selected("admin")) await runAdminScenarios(run);

  // Ahead of Photos: its long timeline queues minutes of jobs, which these would wait behind.
  if (selected("derivatives")) await runDerivativeScenarios(run);

  if (selected("photos")) await runPhotoScenarios(run, { freshImage });

  if (selected("concurrency")) await runConcurrentUploadScenario(run);

  if (selected("touch")) await runTouchScenarios(run);

  if (selected("readiness")) await runReadinessScenarios(run);

  if (selected("tray-reach"))
    await report.scenario("Tray reach fixtures and matrix", () => runTrayReachScenarios(run));

  if (only?.includes("screens")) await runScreenScenarios(run);

  if (only?.includes("interface")) await runInterfaceScenarios(run);

  if (only?.includes("account")) await runAccountScenarios(run);

  // Own fresh account library: run separately with --scenarios=phone-completion.
  if (only?.includes("phone-completion")) await runPhoneCompletionScenarios(run);

  if (only?.includes("resume")) await runResumeScenarios(run);

  if (only?.includes("download-soak")) await runDownloadSoak(run, 150);

  // Uses this run's own disposable network, removed at once, as other workloads do on a shared host.
  if (only?.includes("download-network-change")) {
    await runDownloadSoak(run, 40, () => {
      const name = `hyori-browser-probe-${crypto.randomUUID().slice(0, 8)}`;

      setTimeout(() => {
        spawnSync("docker", ["network", "create", name], { stdio: "ignore" });
        spawnSync("docker", ["network", "rm", name], { stdio: "ignore" });
      }, Math.random() * 500);
    });
  }

  // Only when named: it depends on the bundle handed to this run, and takes a long time.
  if (only?.includes("editors")) await runEditorScenarios(run);

  if (only?.includes("thumbnail-latency")) await runThumbnailLatencyObservation(run, artifacts);

  // Only when named: it injects states, so it must never read as part of whole-app acceptance.
  if (only?.includes("thumbnail-states")) await runThumbnailStateScenario(run);

  writeFileSync(
    join(artifacts, "transport-evidence.json"),
    JSON.stringify(
      {
        browserFailures: report.browserFailures,
        gateway: front.transport,
        hostNetwork: hostNetwork.events,
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(artifacts, "traffic.json"),
    JSON.stringify(
      front.trace.filter((record) => record.path.startsWith("/api/")),
      null,
      1,
    ),
  );

  failed = report.finish({
    frontendSources: web.sourceDigest,
    frontendSourcesUnchangedDuringRun: frontendIdentity() === web.sourceDigest,
    frontendBuild: web.buildDigest,
    frontendNitro: web.nitroDigest,
    frontendPublicAssets: web.publicAssetsDigest,
    webImage,
    webImageId: web.webImageId,
    webRuntime: web.webRuntime,
    editorBundle:
      editorBundle === null
        ? null
        : {
            manifestSha256: editorBundle.manifestSha256,
            purpose: editorBundle.purpose,
            editors: editorBundle.editors.map(({ app, version }) => `${app} ${version}`),
          },
    webHostErrors: web.errors().slice(0, 1200),
    apiRoute: "gateway, then the Nitro host adapter, then Rust",
    image,
    worker,
    protocol,
    chromium: browser.version(),
    hostNetwork: summarizeHostNetwork(
      hostNetwork.events.filter(({ at }) => at >= browserStartedAt),
      report.browserFailures,
    ),
    hostNetworkSettledBeforeBrowser: settled,
  });
  await browser.close();
} catch (error) {
  console.error(error);
  report.record("browser run aborted", "fail", String(error));
  report.finish({ image, protocol, aborted: String(error) });
} finally {
  cleanup();
}

process.exit(failed === 0 ? 0 : 1);
