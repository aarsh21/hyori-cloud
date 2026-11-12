import { execFileSync, spawn } from "node:child_process";
import { createHash, X509Certificate } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { availablePort } from "../available-port.ts";

export type FixtureTls = {
  readonly key: string;
  readonly cert: string;
  readonly dispose: () => void;
};

/** A certificate authority that exists for this run. Only this fixture's processes ever trust it. */
export function createDisposableTls(hostname: string): FixtureTls {
  const directory = mkdtempSync(join(tmpdir(), "hyori-browser-tls-"));
  const file = (name: string) => join(directory, name);

  const openssl = (...args: string[]) =>
    execFileSync("openssl", args, { stdio: ["ignore", "ignore", "ignore"], timeout: 30_000 });

  openssl(
    "req",
    "-x509",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-days",
    "1",
    "-subj",
    "/CN=Hyori browser fixture CA",
    "-keyout",
    file("ca.key"),
    "-out",
    file("ca.crt"),
  );
  openssl(
    "req",
    "-newkey",
    "rsa:2048",
    "-nodes",
    "-subj",
    `/CN=${hostname}`,
    "-keyout",
    file("leaf.key"),
    "-out",
    file("leaf.csr"),
  );
  writeFileSync(file("leaf.ext"), `subjectAltName=DNS:${hostname},IP:127.0.0.1\n`);
  openssl(
    "x509",
    "-req",
    "-in",
    file("leaf.csr"),
    "-CA",
    file("ca.crt"),
    "-CAkey",
    file("ca.key"),
    "-CAcreateserial",
    "-days",
    "1",
    "-extfile",
    file("leaf.ext"),
    "-out",
    file("leaf.crt"),
  );

  return {
    key: readFileSync(file("leaf.key"), "utf8"),
    cert: readFileSync(file("leaf.crt"), "utf8"),
    dispose: () => rmSync(directory, { recursive: true, force: true }),
  };
}

/**
 * Chromium's trust for exactly this run's key, and nothing else: every other certificate error stays
 * an error. Playwright's `ignoreHTTPSErrors` would instead accept anything from any host.
 */
export function chromiumTrustFor(certificate: string) {
  const key = new X509Certificate(certificate).publicKey.export({ type: "spki", format: "der" });

  return `--ignore-certificate-errors-spki-list=${createHash("sha256").update(key).digest("base64")}`;
}

function treeDigest(roots: readonly string[]) {
  const digest = createHash("sha256");

  for (const root of roots) {
    const files = readdirSync(root, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name))
      .sort();

    for (const file of files) digest.update(file).update(readFileSync(file));
  }

  return digest.digest("hex");
}

/** The editors draw with WebGL, which headless Chromium here only has in software. */
export const EDITOR_RENDERING_ARGS = [
  "--use-angle=swiftshader",
  "--enable-unsafe-swiftshader",
  "--ignore-gpu-blocklist",
] as const;

/**
 * An artifact's identity whatever directory holds it: each file's path relative to the root, then
 * its bytes. `frontendIdentity` keeps repository paths, because it names a source freeze.
 */
export function artifactDigest(root: string) {
  const digest = createHash("sha256");

  const files = readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => [relative(root, file), file] as const)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  for (const [path, file] of files) digest.update(path).update("\0").update(readFileSync(file));

  return digest.digest("hex");
}

/** Everything that reaches the browser bundle: the SDK and contracts as much as the screens. */
export function frontendIdentity() {
  return treeDigest([
    "apps/web/src",
    "packages/features/src",
    "packages/ui/src",
    "packages/client-sdk/src",
    "packages/api/src",
    "packages/lib/src",
  ]);
}

/** A running frontend, however it got there: what a run needs from it, and how to identify it. */
export type WebHost = {
  readonly url: string;
  readonly stop: () => void;
  /** The backend address this frontend was really given, which must never reach a browser. */
  readonly backendUrl: string;
  /** This checkout's sources. A web image's identity is `webImageId` and the digests below. */
  readonly sourceDigest: string;
  readonly buildDigest: string;
  readonly nitroDigest: string;
  readonly publicAssetsDigest: string;
  readonly webImageId: string | null;
  readonly webRuntime: string;
  readonly publicDirectory: string;
  readonly errors: () => string;
};

/** What the workspace's own build would put in the image: see `apps/web/Dockerfile`. */
function copyWorkspaceRuntime(root: string, directory: string, build: boolean) {
  if (build) {
    execFileSync("bun", ["run", "--cwd", "apps/web", "build"], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_ENV: "production" },
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 240_000,
    });
  }

  cpSync(join(root, "apps/web/.output"), join(directory, "output"), { recursive: true });
  cpSync(join(root, "apps/web/.env.schema"), join(directory, ".env.schema"));
  mkdirSync(join(directory, "node_modules/.bin"), { recursive: true });
  cpSync(join(root, "node_modules/varlock"), join(directory, "node_modules/varlock"), {
    recursive: true,
    dereference: true,
  });
  cpSync(join(root, "apps/web/node_modules/react"), join(directory, "node_modules/react"), {
    recursive: true,
    dereference: true,
  });
  symlinkSync("../varlock/bin/cli.js", join(directory, "node_modules/.bin/varlock"));
}

/**
 * Runs this checkout's production build as `apps/web/Dockerfile` lays it out: Nitro's output, the
 * env schema, Varlock, and React, in a directory of its own with a clean environment. A private copy
 * also means a concurrent build can't replace what's under test mid-run. It runs on this host's
 * Node, so it's no evidence about a final image: `createWebImageHost` is for that.
 */
export async function startBuiltWeb({
  origin,
  backendUrl,
  build,
}: {
  origin: string;
  backendUrl: string;
  build: boolean;
}): Promise<WebHost> {
  const root = process.cwd();
  const sourceDigest = frontendIdentity();
  const directory = mkdtempSync(join(tmpdir(), "hyori-browser-web-"));

  const stopCopy = () => {
    execFileSync("chmod", ["-R", "u+w", directory], { stdio: "ignore" });
    rmSync(directory, { recursive: true, force: true });
  };

  try {
    copyWorkspaceRuntime(root, directory, build);
  } catch (error) {
    stopCopy();
    throw error;
  }

  // Separately, so it can be compared with a final web image's own copy of each.
  const buildDigest = artifactDigest(join(directory, "output"));
  const nitroDigest = artifactDigest(join(directory, "output/server"));
  const publicAssetsDigest = artifactDigest(join(directory, "output/public"));

  // The image runs from a read-only root, so anything that needs to write here should fail here too.
  execFileSync("chmod", ["-R", "a-w", directory], { stdio: "ignore" });

  const port = await availablePort();
  const url = `http://127.0.0.1:${port}`;

  const child = spawn("node", [join(directory, "output/server/index.mjs")], {
    cwd: directory,
    // No inherited credentials or .env files: the web host holds only these.
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "production",
      APP_ENV: "production",
      APP_ORIGIN: origin,
      HYORI_BACKEND_URL: backendUrl,
      HOST: "127.0.0.1",
      PORT: String(port),
    },
    stdio: ["ignore", "ignore", "pipe"],
  });

  let errors = "";

  child.stderr.on("data", (chunk: Buffer) => {
    errors = `${errors}${chunk.toString("utf8")}`.slice(0, 6000);
  });

  const stop = () => {
    child.kill("SIGTERM");
    stopCopy();
  };

  const publicDirectory = join(directory, "output/public");
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      const output = errors;

      stop();
      throw new Error(`The built frontend exited during startup.\n${output}`);
    }

    try {
      const response = await fetch(url, {
        headers: { host: new URL(origin).host },
        signal: AbortSignal.timeout(1000),
      });

      await response.body?.cancel();

      if (response.status < 500) {
        return {
          url,
          stop,
          backendUrl,
          sourceDigest,
          buildDigest,
          nitroDigest,
          publicAssetsDigest,
          webImageId: null,
          webRuntime: execFileSync("node", ["--version"], { encoding: "utf8" }).trim(),
          publicDirectory,
          errors: () => errors,
        };
      }
    } catch {
      // Not listening yet.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  stop();
  throw new Error(`The built frontend never answered.\n${errors}`);
}
