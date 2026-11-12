// Failure drills against a running Compose deployment, driven through the public SDK and the gateway.
//
//   bun scripts/ops-drills.ts <drill> --origin … --ca … --manifest m.json [--project hyori-cloud-rust]
//       [--env-file .env.deployment]
//
// Drills:
//   restart-each     `docker compose restart` each long-running service in turn; measure downtime.
//   crash-upload     SIGKILL the backend while a 160 MiB upload is in flight, then retry it.
//   crash-download   SIGKILL the backend while a large download streams, then download again.
//   outage <service> stop postgres or rustfs for 20 s under upload/download load, then start it.
//
// Every drill ends by verifying the seeded dataset (`ops-dataset.ts verify`) byte for byte.
// "Crash" means SIGKILL to the container's init from the host: the restart policy then applies,
// exactly as for a crashed process, which `docker kill` (a manual stop) would not show.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  connect,
  diskFile,
  clientError,
  describe,
  hashStream,
  login,
  options,
  readChurnLog,
  readManifest,
  writeRandomFile,
} from "./ops-client.ts";

const args = options();
const drill = args.positional[0];
const gateway = args.gateway();
const project = args.get("project", "hyori-cloud-rust");
const envFile = args.get("env-file", ".env.deployment");
const manifestPath = args.get("manifest");

const manifest = await readManifest(manifestPath);

const started = performance.now();

function log(message: string) {
  process.stdout.write(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}\n`);
}

function sh(file: string, argv: string[]) {
  return execFileSync(file, argv, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function compose(...argv: string[]) {
  return sh("docker", ["compose", "--project-name", project, "--env-file", envFile, ...argv]);
}

function crash(service: string) {
  const id = compose("ps", "--quiet", service);
  const pid = sh("docker", ["inspect", "--format", "{{.State.Pid}}", id]);
  sh("sudo", ["kill", "-KILL", pid]);
  log(`SIGKILL ${service} (host pid ${pid})`);
}

/** Seconds until an authenticated RPC through the gateway succeeds again. */
async function untilServing(limitSeconds = 240) {
  const from = performance.now();

  const session = await login(gateway, manifest.owner.email, manifest.owner.password).catch(() =>
    connect(gateway, manifest.owner.email),
  );

  for (;;) {
    try {
      await session.sdk.rpc.files.list({ parentId: null, limit: 1 });
      session.sdk.dispose();

      return (performance.now() - from) / 1000;
    } catch {
      if (performance.now() - from > limitSeconds * 1000)
        throw new Error(`Not serving after ${limitSeconds}s.`);
      await Bun.sleep(250);
    }
  }
}

function verifyDataset() {
  const out = execFileSync(
    "bun",
    [
      join(import.meta.dir, "ops-dataset.ts"),
      "verify",
      "--origin",
      gateway.origin,
      ...(gateway.caPath ? ["--ca", gateway.caPath] : []),
      "--manifest",
      manifestPath,
    ],
    { encoding: "utf8" },
  ).trim();

  log(out);
}

function restartCount(service: string) {
  return sh("docker", [
    "inspect",
    "--format",
    "{{.RestartCount}}",
    compose("ps", "--quiet", service),
  ]);
}

async function restartEach() {
  for (const service of ["postgres", "rustfs", "media-worker", "backend", "web"]) {
    const from = performance.now();
    compose("restart", service);
    const restart = (performance.now() - from) / 1000;
    const serving = await untilServing();
    log(
      `${service}: restart command ${restart.toFixed(1)}s, serving again after +${serving.toFixed(1)}s`,
    );
  }

  verifyDataset();
}

async function crashUpload() {
  const scratch = "/tmp/hyori-drill";
  mkdirSync(scratch, { recursive: true });
  const path = join(scratch, "crash-upload.bin");
  const sha256 = await writeRandomFile(path, 160 * 1024 * 1024 + 3);
  const session = await login(gateway, manifest.owner.email, manifest.owner.password);
  const before = restartCount("backend");
  let crashed = false;

  const task = session.sdk.uploads.start({
    parentId: manifest.folders.Documents!,
    file: diskFile(path, `crash-upload-${Date.now()}.bin`),
  });

  task.subscribe(() => {
    const snapshot = task.getSnapshot();

    if (!crashed && snapshot.uploadedBytes >= 64 * 1024 * 1024) {
      crashed = true;
      log(`upload at ${snapshot.uploadedBytes} B of ${snapshot.totalBytes}`);
      crash("backend");
    }
  });

  const failure = await task.result.then(
    () => null,
    (error) => describe(clientError(error)),
  );

  log(
    failure
      ? `user sees upload fail: ${failure.code} (${failure.message}); snapshot ${JSON.stringify({ status: task.getSnapshot().status, uploadedBytes: task.getSnapshot().uploadedBytes })}`
      : "upload completed despite the crash (SDK retries absorbed it)",
  );
  log(
    `backend serving again after ${(await untilServing()).toFixed(1)}s; restarts ${before} → ${restartCount("backend")}`,
  );
  let entry;

  if (failure) {
    const resumedFrom = task.getSnapshot().uploadedBytes;
    entry = await task.retry();
    log(`retry from ${resumedFrom} B completed: ${entry.id}`);
  } else entry = await task.result;

  const read = await hashStream((await session.sdk.downloads.open({ id: entry.id })).stream);
  log(`crash-upload result ${read.sha256 === sha256 ? "INTACT" : "CORRUPT"} (${read.bytes} B)`);
  task.dispose();
  session.sdk.dispose();
  verifyDataset();
}

async function crashDownload() {
  const largest = manifest.files.toSorted((a, b) => b.size - a.size)[0]!;
  const session = await login(gateway, manifest.owner.email, manifest.owner.password);
  const opened = await session.sdk.downloads.open({ id: largest.id });
  let bytes = 0;
  let crashed = false;
  let failure: ReturnType<typeof describe> | null = null;

  try {
    for await (const chunk of opened.stream) {
      bytes += chunk.byteLength;

      if (!crashed && bytes >= 32 * 1024 * 1024) {
        crashed = true;
        crash("backend");
      }
    }
  } catch (error) {
    failure = describe(clientError(error));
  }

  log(
    failure
      ? `user sees download stop after ${bytes} of ${largest.size} B: ${failure.code} (${failure.message})`
      : `download stream ended after ${bytes} of ${largest.size} B with NO error`,
  );
  log(`backend serving again after ${(await untilServing()).toFixed(1)}s`);
  const again = await hashStream((await session.sdk.downloads.open({ id: largest.id })).stream);
  log(
    `second download ${again.sha256 === largest.sha256 ? "INTACT" : "CORRUPT"} (${again.bytes} B)`,
  );
  session.sdk.dispose();
  verifyDataset();
}

async function outage(service: string) {
  if (service !== "postgres" && service !== "rustfs") throw new Error("outage postgres|rustfs");
  const churnLog = `/tmp/hyori-drill-outage-${service}-${Date.now()}.jsonl`;

  const churnArgs = [
    "--origin",
    gateway.origin,
    ...(gateway.caPath ? ["--ca", gateway.caPath] : []),
    "--manifest",
    manifestPath,
    "--log",
    churnLog,
  ];

  const churn = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "ops-churn.ts"),
      ...churnArgs,
      "--seconds",
      "60",
      "--workers",
      "2",
    ],
    { stdout: "pipe", stderr: "inherit" },
  );

  await Bun.sleep(10_000);
  compose("stop", service);
  log(`stopped ${service}`);
  await Bun.sleep(20_000);
  compose("start", service);
  log(`started ${service}; serving after ${(await untilServing()).toFixed(1)}s`);
  await churn.exited;
  log((await new Response(churn.stdout).text()).trim());

  const entries = readChurnLog(churnLog);

  const failed = entries.filter((entry) => !entry.ok);

  if (failed.length)
    log(
      `failures from ${failed[0]!.at} to ${failed.at(-1)!.at}: ${[...new Set(failed.map((entry) => `${entry.op}:${entry.error} ${entry.detail ?? ""}`))].join(", ")}`,
    );

  const recovered = entries.filter(
    (entry) => entry.ok && failed.length && entry.at > failed.at(-1)!.at,
  );

  log(`${recovered.length} operations succeeded after the last failure`);
  log(
    execFileSync("bun", [join(import.meta.dir, "ops-churn.ts"), "check", ...churnArgs], {
      encoding: "utf8",
    }).trim(),
  );
  log(`backend restarts: ${restartCount("backend")}`);
  verifyDataset();
}

if (drill === "restart-each") await restartEach();
else if (drill === "crash-upload") await crashUpload();
else if (drill === "crash-download") await crashDownload();
else if (drill === "outage") await outage(args.positional[1] ?? "");
else
  throw new Error(
    "Usage: ops-drills.ts restart-each|crash-upload|crash-download|outage <service> …",
  );
