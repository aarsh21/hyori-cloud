import { randomBytes } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { availablePort as freePort } from "./available-port.ts";
import { setTimeout as delay } from "node:timers/promises";
import { createServiceProbe } from "./service-sdk-probe";
import { createHandler } from "@hyori-cloud/api";

const suffix = randomBytes(6).toString("hex");
const names = { database: `hyori-test-${suffix}-db`, storage: `hyori-test-${suffix}-storage` };

const volumes = [
  `hyori-test-${suffix}-db-data`,
  `hyori-test-${suffix}-storage-data`,
  `hyori-test-${suffix}-storage-logs`,
];

const credentials = {
  database: randomBytes(24).toString("hex"),
  access: randomBytes(12).toString("hex"),
  storage: randomBytes(24).toString("hex"),
};

const started: string[] = [];
const createdVolumes: string[] = [];
let appProcess: ReturnType<typeof spawn> | undefined;

function docker(...args: string[]): string {
  const result = spawnSync("docker", args, { encoding: "utf8" });

  if (result.status !== 0) throw new Error(`Docker command failed: ${result.stderr.trim()}`);

  return result.stdout.trim();
}

function endpoint(name: string, port: number): string {
  let published: string;

  try {
    published = docker("port", name, `${port}/tcp`);
  } catch {
    const logs = spawnSync("docker", ["logs", name], { encoding: "utf8" });
    throw new Error(
      `Test container failed before publishing its port: ${name}\n${logs.stdout}\n${logs.stderr}`,
    );
  }

  const address = published.split("\n")[0];

  if (!address?.startsWith("127.0.0.1:")) throw new Error("Test service is not bound to loopback.");

  return `http://${address}`;
}

async function waitUntilReady(url: string, name: string): Promise<void> {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      await response.body?.cancel();

      if (response.status < 500) return;
    } catch {
      // A new test container can accept TCP before its HTTP listener is ready.
    }

    if (docker("inspect", "--format", "{{.State.Running}}", name) !== "true") {
      throw new Error(`Test service exited during startup: ${name}`);
    }

    await delay(250);
  }

  throw new Error(`Test service did not become ready: ${url}`);
}

function cleanup(): void {
  appProcess?.kill("SIGTERM");

  for (const name of started.splice(0)) {
    spawnSync("docker", ["rm", "--force", name], { stdio: "ignore" });
  }

  for (const name of createdVolumes.splice(0)) {
    spawnSync("docker", ["volume", "rm", name], { stdio: "ignore" });
  }
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(130);
  });
}

let probe: Awaited<ReturnType<typeof createServiceProbe>> | undefined;
let mountedApi: ReturnType<typeof createHandler> | undefined;

try {
  console.log("Starting isolated persistent SurrealDB and RustFS test services (loopback only).");
  const databasePort = await freePort();
  let storagePort = await freePort();

  while (storagePort === databasePort) storagePort = await freePort();

  for (const volume of volumes) {
    docker("volume", "create", volume);
    createdVolumes.push(volume);
  }

  docker(
    "run",
    "--rm",
    "--volume",
    `${volumes[0]}:/database`,
    "--volume",
    `${volumes[1]}:/storage`,
    "--volume",
    `${volumes[2]}:/logs`,
    "alpine:3.22",
    "sh",
    "-c",
    "chown 65532:65532 /database && chown 10001:10001 /storage /logs",
  );
  docker(
    "run",
    "--detach",
    "--name",
    names.database,
    "--publish",
    `127.0.0.1:${databasePort}:8000`,
    "--mount",
    `type=volume,src=${volumes[0]},dst=/data,volume-nocopy`,
    "--workdir",
    "/data",
    "surrealdb/surrealdb:v2.6.5",
    "start",
    "--bind",
    "0.0.0.0:8000",
    "--user",
    "root",
    "--pass",
    credentials.database,
    "surrealkv:///data/hyori.db",
  );
  started.push(names.database);
  docker(
    "run",
    "--detach",
    "--name",
    names.storage,
    "--publish",
    `127.0.0.1:${storagePort}:9000`,
    "--mount",
    `type=volume,src=${volumes[1]},dst=/data,volume-nocopy`,
    "--mount",
    `type=volume,src=${volumes[2]},dst=/logs,volume-nocopy`,
    "--env",
    `RUSTFS_ACCESS_KEY=${credentials.access}`,
    "--env",
    `RUSTFS_SECRET_KEY=${credentials.storage}`,
    "--env",
    "RUSTFS_CONSOLE_ENABLE=false",
    "rustfs/rustfs:1.0.0-alpha.85",
    "/data",
  );
  started.push(names.storage);
  const database = endpoint(names.database, 8000);
  const storage = endpoint(names.storage, 9000);
  await Promise.all([
    waitUntilReady(`${database}/health`, names.database),
    waitUntilReady(storage, names.storage),
  ]);

  const test = spawn("bun", ["test", "packages/core/test", "packages/api/test"], {
    stdio: "inherit",
    env: {
      ...process.env,
      HYORI_TEST_SURREAL_URL: database,
      HYORI_TEST_SURREAL_USER: "root",
      HYORI_TEST_SURREAL_PASSWORD: credentials.database,
      HYORI_TEST_STORAGE_ENDPOINT: storage,
      HYORI_TEST_STORAGE_ACCESS_KEY: credentials.access,
      HYORI_TEST_STORAGE_SECRET_KEY: credentials.storage,
    },
  });

  const code = await new Promise<number>((resolve, reject) => {
    test.once("error", reject);
    test.once("exit", (exitCode) => resolve(exitCode ?? 1));
  });

  if (code !== 0) throw new Error(`Real-service test suite failed (${code}).`);

  const probeConfig = {
    origin: "http://localhost:4199",
    setupToken: randomBytes(24).toString("hex"),
    secureCookies: false,
    defaultQuotaBytes: 64 * 1024 ** 2,
    surreal: {
      url: database,
      namespace: "hyori_test",
      database: `probe_${suffix}`,
      username: "root",
      password: credentials.database,
    },
    storage: {
      endpoint: storage,
      region: "us-east-1",
      bucket: `hyori-probe-${suffix}`,
      accessKeyId: credentials.access,
      secretAccessKey: credentials.storage,
    },
  };

  mountedApi = createHandler(probeConfig);
  const mounted = mountedApi;
  probe = await createServiceProbe(probeConfig, async (input, init) =>
    mounted(new Request(input, init)),
  );
  console.log(
    "Public vanilla SDK multipart upload/download passed. Restarting both services to check durability.",
  );
  docker("restart", names.database, names.storage);
  await Promise.all([
    waitUntilReady(`${database}/health`, names.database),
    waitUntilReady(storage, names.storage),
  ]);
  await probe.verifyAfterRestart();
  console.log(
    "Public SDK session, metadata, and original file bytes survived both service restarts.",
  );

  const appPort = await freePort();
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const setupToken = randomBytes(24).toString("hex");
  appProcess = spawn("node", [".output/server/index.mjs"], {
    cwd: `${process.cwd()}/apps/web`,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "production",
      APP_ENV: "test",
      HOST: "127.0.0.1",
      PORT: String(appPort),
      APP_ORIGIN: appOrigin,
      HYORI_SETUP_TOKEN: setupToken,
      SURREALDB_URL: database,
      SURREALDB_NAMESPACE: "hyori_test",
      SURREALDB_DATABASE: `app_${suffix}`,
      SURREALDB_USERNAME: "root",
      SURREALDB_PASSWORD: credentials.database,
      RUSTFS_ENDPOINT: storage,
      RUSTFS_REGION: "us-east-1",
      RUSTFS_BUCKET: `hyori-app-${suffix}`,
      RUSTFS_ACCESS_KEY: credentials.access,
      RUSTFS_SECRET_KEY: credentials.storage,
      DEFAULT_QUOTA_BYTES: String(64 * 1024 ** 2),
    },
  });
  const appDeadline = Date.now() + 30_000;
  let appReady = false;

  while (Date.now() < appDeadline && appProcess.exitCode === null) {
    try {
      const response = await fetch(appOrigin, { signal: AbortSignal.timeout(2_000) });

      if (response.ok && (await response.text()).includes("Hyori")) {
        appReady = true;
        break;
      }
    } catch {
      /* The built HTTP host has not opened its listener yet. */
    }

    await delay(200);
  }

  if (!appReady)
    throw new Error("Built web host did not become ready; run the web build before this suite.");

  const httpProbe = await createServiceProbe(
    { origin: appOrigin, setupToken },
    globalThis.fetch.bind(globalThis),
  );

  httpProbe.dispose();
  console.log(
    "Built TanStack HTTP routes passed real SDK bootstrap, folder, multipart upload and download checks.",
  );
} catch (error) {
  console.error(error instanceof Error ? error.stack : "Service integration test failed.");

  for (const name of started) {
    const logs = spawnSync("docker", ["logs", "--tail", "30", name], { encoding: "utf8" });
    console.error(`Test service logs: ${name}\n${logs.stdout}\n${logs.stderr}`);
  }

  process.exitCode = 1;
} finally {
  probe?.dispose();
  mountedApi?.dispose();
  cleanup();
}
