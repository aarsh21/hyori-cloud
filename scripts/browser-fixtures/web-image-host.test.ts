import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { artifactDigest } from "./web-host.ts";
import { createWebImageHost, webContainerArgs } from "./web-image-host.ts";
import type { DockerCli, DockerResult } from "./web-image-host.ts";

const IMAGE_ID = "sha256:exact-image";
const ORIGIN = "https://localhost:24000";
const BACKEND = { network: "hyori-browser-abc", url: "http://hyori-browser-pg-abc:3002" };

const servers: ReturnType<typeof Bun.serve>[] = [];
const scratch: string[] = [];

afterEach(() => {
  for (const server of servers.splice(0)) void server.stop(true);

  for (const directory of scratch.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const ok = (stdout = ""): DockerResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string): DockerResult => ({ status: 1, stdout: "", stderr });

function writeOutput(output: string) {
  mkdirSync(join(output, "server"), { recursive: true });
  mkdirSync(join(output, "public"), { recursive: true });
  writeFileSync(join(output, "server/index.mjs"), "export {};");
  writeFileSync(join(output, "public/app.js"), "console.log(1);");
}

const RUNNING = {
  Image: IMAGE_ID,
  HostConfig: {
    ReadonlyRootfs: true,
    NetworkMode: BACKEND.network,
    CapDrop: ["ALL"],
    SecurityOpt: ["no-new-privileges"],
  },
  Mounts: [],
};

/** A pretend Docker that behaves until told otherwise, and remembers everything it was asked. */
function fakeDocker(
  overrides: Partial<Record<string, (args: readonly string[]) => DockerResult>> = {},
) {
  const calls: (readonly string[])[] = [];
  const copies: string[] = [];
  const web = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>") });

  servers.push(web);

  const docker: DockerCli = (args) => {
    calls.push(args);

    const verb = args[0] ?? "";
    const override = overrides[verb];

    if (override !== undefined) return override(args);

    switch (verb) {
      case "image":
        return ok(IMAGE_ID);
      case "cp": {
        const output = args[2] ?? "";

        copies.push(dirname(output));
        writeOutput(output);

        return ok();
      }

      case "port":
        return ok(`127.0.0.1:${web.port}`);
      case "inspect":
        return ok(args[2] === "{{.State.Running}}" ? "true" : JSON.stringify(RUNNING));
      case "exec":
        return ok("v24.11.0");
      default:
        return ok();
    }
  };

  const removed = () => calls.flatMap((call) => (call[0] === "rm" ? [call.at(-1) ?? ""] : []));

  return { docker, calls, copies, removed };
}

const hostWith = (docker: DockerCli, readyTimeoutMs = 2000) =>
  createWebImageHost({
    image: "web:final",
    origin: ORIGIN,
    backend: BACKEND,
    docker,
    readyTimeoutMs,
  });

describe("the web container's boundary", () => {
  const args = webContainerArgs({
    name: "web",
    imageId: IMAGE_ID,
    origin: ORIGIN,
    backend: BACKEND,
  });

  test("matches the deployment's: read-only, no capabilities, no new privileges", () => {
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop=ALL");
    expect(args).toContain("--security-opt=no-new-privileges");
    expect(args).toContain("--init");
  });

  test("is on the fixture's own network, never the host's", () => {
    expect(args[args.indexOf("--network") + 1]).toBe(BACKEND.network);
    expect(args).not.toContain("host");
  });

  test("publishes only a random loopback port", () => {
    expect(args[args.indexOf("--publish") + 1]).toBe("127.0.0.1::3001");
    expect(args.filter((arg) => arg === "--publish")).toHaveLength(1);
  });

  test("hands over only public settings, and nothing from this host", () => {
    const env = args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : []));

    expect(env).toEqual([
      "NODE_ENV=production",
      "APP_ENV=production",
      `APP_ORIGIN=${ORIGIN}`,
      `HYORI_BACKEND_URL=${BACKEND.url}`,
    ]);
  });

  test("has no mounts or env files of any kind", () => {
    for (const flag of ["--mount", "--volume", "-v", "--tmpfs", "--env-file", "--volumes-from"]) {
      expect(args).not.toContain(flag);
    }
  });

  test("runs the image's own command, by its exact ID", () => {
    expect(args.at(-1)).toBe(IMAGE_ID);
  });
});

describe("starting the exact image", () => {
  test("runs it in a container, and hashes a copy of its own files", async () => {
    const { docker, calls, copies } = fakeDocker();
    const host = hostWith(docker);
    const web = await host.start();

    try {
      const parent = mkdtempSync(join(tmpdir(), "hyori-web-expected-"));

      scratch.push(parent);
      writeOutput(join(parent, "elsewhere"));

      expect(web.webImageId).toBe(IMAGE_ID);
      expect(web.webRuntime).toBe("v24.11.0");
      expect(web.backendUrl).toBe(BACKEND.url);
      expect(web.buildDigest).toBe(artifactDigest(join(parent, "elsewhere")));
      expect(web.nitroDigest).toBe(artifactDigest(join(parent, "elsewhere/server")));
      expect(web.publicAssetsDigest).toBe(artifactDigest(join(parent, "elsewhere/public")));
      expect(calls.some(([verb]) => verb === "run")).toBe(true);
      expect(web.publicDirectory.startsWith(copies[0] ?? "missing")).toBe(true);
    } finally {
      host.stop();
    }
  });

  test("the copy comes from a container that never runs and has no network", async () => {
    const { docker, calls } = fakeDocker();
    const host = hostWith(docker);

    await host.start();
    host.stop();

    const create = calls.find(([verb]) => verb === "create") ?? [];

    expect(create).toContain("none");
    expect(create.at(-1)).toBe(IMAGE_ID);
  });

  test("everything after resolving the tag uses the image's ID", async () => {
    const { docker, calls } = fakeDocker();
    const host = hostWith(docker);

    await host.start();
    host.stop();

    expect(calls.filter((call) => call.includes("web:final"))).toHaveLength(1);
    expect(calls.find(([verb]) => verb === "image")).toContain("web:final");
  });

  test("stopping removes the container and the copy, once", async () => {
    const { docker, copies, removed } = fakeDocker();
    const host = hostWith(docker);

    await host.start();

    const before = removed().length;

    host.stop();
    host.stop();

    expect(removed().length).toBe(before + 2);
    expect(existsSync(copies[0] ?? "missing")).toBe(false);
  });
});

describe("every way starting can fail cleans up", () => {
  async function expectCleanFailure(
    overrides: Parameters<typeof fakeDocker>[0],
    message: RegExp,
    readyTimeoutMs?: number,
  ) {
    const { docker, copies, removed } = fakeDocker(overrides);

    await expect(hostWith(docker, readyTimeoutMs).start()).rejects.toThrow(message);
    expect(removed().some((name) => name.startsWith("hyori-browser-web-artifact-"))).toBe(true);
    expect(removed().some((name) => /^hyori-browser-web-[0-9a-f]{16}$/.test(name))).toBe(true);

    for (const copy of copies) expect(existsSync(copy)).toBe(false);
  }

  test("the image doesn't exist", () =>
    expectCleanFailure({ image: () => failed("No such image") }, /docker image failed/));

  test("its files can't be copied", () =>
    expectCleanFailure({ cp: () => failed("no such path") }, /docker cp failed/));

  test("the container won't start, which can still leave one behind", () =>
    expectCleanFailure({ run: () => failed("port is already allocated") }, /docker run failed/));

  test("it's reachable from more than loopback", () =>
    expectCleanFailure({ port: () => ok("0.0.0.0:49000") }, /loopback only/));

  test("one loopback address among others isn't enough", () =>
    expectCleanFailure({ port: () => ok("127.0.0.1:49000\n0.0.0.0:49000") }, /loopback only/));

  test("it exits during startup, and says why", () =>
    expectCleanFailure(
      {
        inspect: () => ok("false"),
        logs: () => ({ status: 0, stdout: "", stderr: "varlock: invalid APP_ORIGIN" }),
      },
      /exited during startup[\s\S]*invalid APP_ORIGIN/,
    ));

  test("it never answers", () => {
    const silent = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response("", { status: 503 }),
    });

    servers.push(silent);

    return expectCleanFailure(
      { port: () => ok(`127.0.0.1:${silent.port}`) },
      /never answered/,
      300,
    );
  });

  test.each([
    [
      "a writable root",
      { ...RUNNING, HostConfig: { ...RUNNING.HostConfig, ReadonlyRootfs: false } },
    ],
    [
      "the host's network",
      { ...RUNNING, HostConfig: { ...RUNNING.HostConfig, NetworkMode: "host" } },
    ],
    ["capabilities kept", { ...RUNNING, HostConfig: { ...RUNNING.HostConfig, CapDrop: null } }],
    ["new privileges", { ...RUNNING, HostConfig: { ...RUNNING.HostConfig, SecurityOpt: [] } }],
    ["a mount", { ...RUNNING, Mounts: [{ Type: "bind" }] }],
    ["a different image", { ...RUNNING, Image: "sha256:other" }],
  ])("it really started with %s", (_, running) =>
    expectCleanFailure(
      {
        inspect: (args) => ok(args[2] === "{{.State.Running}}" ? "true" : JSON.stringify(running)),
      },
      /deployment's boundary/,
    ),
  );

  test("the image isn't on Node 24", () =>
    expectCleanFailure({ exec: () => ok("v26.12.1") }, /not Node v24/));

  test("a failed removal doesn't stop the copy being removed", async () => {
    const { docker, copies } = fakeDocker({ rm: () => failed("daemon went away") });
    const host = hostWith(docker);

    await host.start();
    host.stop();

    expect(existsSync(copies[0] ?? "missing")).toBe(false);
  });
});

describe("how the run uses it", () => {
  const source = (path: string) => readFileSync(join("scripts", path), "utf8");

  test("the runner registers its cleanup before starting anything", () => {
    const runner = source("test-rust-browser.ts");
    const registered = runner.indexOf("cleanups.push(host.stop)");

    expect(registered).toBeGreaterThan(-1);
    expect(registered).toBeLessThan(runner.indexOf("host.start()"));
  });

  test("the runner gives it only the fixture's network and backend name", () => {
    expect(source("test-rust-browser.ts")).toContain("backend: stack.webBackend");
    expect(source("browser-fixtures/rust-stack.ts")).toContain(
      "webBackend: { network, url: `http://${postgres}:3002` }",
    );
  });

  test("the workspace host never touches an image, so nothing extracted runs on this Node", () => {
    expect(source("browser-fixtures/web-host.ts")).not.toContain('"docker"');
  });
});
