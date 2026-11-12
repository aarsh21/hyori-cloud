/** Runs in the web check-types gate, including root `bun run check`. */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { realpathSync } from "node:fs";
import { z } from "zod";

const appRequire = createRequire(new URL("../package.json", import.meta.url));

const app = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(appRequire("./package.json"));

const routerPath = appRequire.resolve("@tanstack/react-router/package.json");
const routerRequire = createRequire(routerPath);

const router = z
  .object({ dependencies: z.record(z.string(), z.string()) })
  .parse(routerRequire("./package.json"));

const corePath = appRequire.resolve("@tanstack/router-core/package.json");
const core = z.object({ version: z.string() }).parse(appRequire(corePath));

assert.equal(app.dependencies["@tanstack/router-core"], core.version, "Pin router-core exactly");

assert.equal(
  router.dependencies["@tanstack/router-core"],
  core.version,
  "Upgrade the app's router-core pin with react-router",
);

assert.equal(
  realpathSync(corePath),
  realpathSync(routerRequire.resolve("@tanstack/router-core/package.json")),
  "Renderer helpers and react-router must resolve the same router-core instance",
);

const lock = z
  .object({ packages: z.record(z.string(), z.tuple([z.string()]).rest(z.unknown())) })
  .parse(Bun.JSONC.parse(await Bun.file(new URL("../../../bun.lock", import.meta.url)).text()));

const lockedVersions = new Set(
  Object.values(lock.packages)
    .map((entry) => entry[0])
    .filter((entry) => entry.startsWith("@tanstack/router-core@")),
);

assert.deepEqual(
  [...lockedVersions],
  [`@tanstack/router-core@${core.version}`],
  "bun.lock must contain exactly one router-core version",
);

console.log(`PASS router-core ${core.version}: exact app pin, shared instance, one locked version`);
