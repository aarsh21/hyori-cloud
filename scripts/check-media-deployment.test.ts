import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const volume = z.object({
  type: z.string(),
  source: z.string(),
  target: z.string(),
  read_only: z.boolean().optional(),
  bind: z.object({ create_host_path: z.boolean().optional() }).optional(),
});

const byteLimit = z
  .union([z.number().int().nonnegative(), z.string().regex(/^\d+$/).transform(Number)])
  .pipe(z.number().int().nonnegative().safe());

const service = z.object({
  user: z.string().optional(),
  stop_grace_period: z.string().optional(),
  network_mode: z.string().optional(),
  read_only: z.boolean().optional(),
  cap_drop: z.array(z.string()).default([]),
  cap_add: z.array(z.string()).default([]),
  security_opt: z.array(z.string()).default([]),
  cpus: z.number().optional(),
  mem_limit: byteLimit.optional(),
  memswap_limit: byteLimit.optional(),
  pids_limit: z.number().optional(),
  tmpfs: z.array(z.string()).default([]),
  volumes: z.array(volume).default([]),
  ports: z.array(z.object({ host_ip: z.string().optional() })).default([]),
  environment: z.record(z.string(), z.string()).default({}),
});

const configuration = z.object({
  services: z.record(z.string(), service),
  volumes: z.record(z.string(), z.object({ name: z.string() })),
});

test("backend image compiles against the authoritative ArtCraft version pins", async () => {
  const dockerfile = await Bun.file(new URL("../apps/server/Dockerfile", import.meta.url)).text();
  expect(dockerfile).toContain(
    "COPY tooling/artcraft/manifest.json tooling/artcraft/runtime-deckcraft-v2.json tooling/artcraft/runtime-native-v3*.json ./tooling/artcraft/",
  );
});

function render(overlays: string[] = []) {
  // Random fixture data only; /dev/null explicitly prevents loading a real deployment env file.
  const password = randomBytes(32).toString("hex");

  const output = execFileSync(
    "docker",
    [
      "compose",
      "--file",
      "docker-compose.yml",
      ...overlays.flatMap((file) => ["--file", file]),
      "--env-file",
      "/dev/null",
      "--project-name",
      "hyori-isolation-fixture",
      "config",
      "--format",
      "json",
    ],
    {
      cwd: fileURLToPath(new URL("../", import.meta.url)),
      encoding: "utf8",
      timeout: 15_000,
      env: {
        PATH: process.env.PATH,
        APP_ENV: "production",
        APP_ORIGIN: "https://cloud.example.test",
        POSTGRES_PASSWORD: password,
        HYORI_DATABASE_URL: `postgres://hyori:${password}@postgres:5432/hyori`,
        HYORI_SETUP_TOKEN: randomBytes(32).toString("hex"),
        HYORI_AUTH_SECRET: randomBytes(32).toString("hex"),
        HYORI_STORAGE_ACCESS_KEY: randomBytes(32).toString("hex"),
        HYORI_STORAGE_SECRET_KEY: randomBytes(32).toString("hex"),
        HYORI_STORAGE_BUCKET: `fixture-${randomBytes(8).toString("hex")}`,
        HYORI_EDITOR_ASSETS_DIR: "/tmp/hyori-editor-render-only-never-mounted",
        HYORI_EDITOR_ASSETS_MANIFEST_SHA256: "a".repeat(64),
      },
    },
  );

  return configuration.parse(JSON.parse(output));
}

test("editor overlay opts into a pinned read-only bundle without adding ports or credentials to web", () => {
  const base = render();
  const enabled = render(["docker-compose.editors.yml"]);
  expect(base.services.backend?.environment.HYORI_EDITOR_ASSETS_DIR).toBeUndefined();
  expect(enabled.services.backend?.environment.HYORI_EDITOR_ASSETS_DIR).toBe("/opt/hyori/artcraft");
  expect(enabled.services.backend?.environment.HYORI_EDITOR_ASSETS_MANIFEST_SHA256).toBe(
    "a".repeat(64),
  );
  expect(enabled.services.backend?.volumes).toContainEqual({
    type: "bind",
    source: "/tmp/hyori-editor-render-only-never-mounted",
    target: "/opt/hyori/artcraft",
    read_only: true,
    bind: { create_host_path: false },
  });
  expect(enabled.services.web).toEqual(base.services.web);
  expect(enabled.volumes).toEqual(base.volumes);

  for (const [name, entry] of Object.entries(enabled.services))
    expect(base.services[name]?.ports).toEqual(entry.ports);
});

test("rendered deployment isolates decoder resources and keeps its sole socket private", () => {
  const config = render();
  const worker = config.services["media-worker"];
  const backend = config.services.backend;
  const permissions = config.services["media-socket-permissions"];

  if (!worker || !backend || !permissions)
    throw new Error("Missing owned media deployment services");

  expect(worker.user).toBe("10001:10001");
  expect(worker.network_mode).toBe("none");
  expect(worker.read_only).toBe(true);
  expect(worker.cap_drop).toEqual(["ALL"]);
  expect(worker.cap_add).toEqual([]);
  expect(worker.security_opt).toContain("no-new-privileges:true");
  expect(worker.cpus).toBe(1);
  expect(worker.mem_limit).toBe(512 * 1024 * 1024);
  expect(worker.memswap_limit).toBe(worker.mem_limit);
  expect(worker.pids_limit).toBe(64);
  expect(worker.tmpfs).toEqual([
    "/scratch:rw,noexec,nosuid,nodev,size=96m,uid=10001,gid=10001,mode=0700",
  ]);
  expect(worker.environment).toEqual({ HYORI_MEDIA_SOCKET: "/run/hyori-media/worker.sock" });
  expect(worker.volumes).toHaveLength(1);
  expect(worker.volumes[0]).toMatchObject({
    type: "volume",
    source: "rust-media-socket",
    target: "/run/hyori-media",
  });
  expect(backend.stop_grace_period).toBe("2m30s");
  expect(backend.environment.HYORI_MEDIA_WORKER_SOCKET).toBe(worker.environment.HYORI_MEDIA_SOCKET);
  expect(backend.volumes).toContainEqual({
    type: "volume",
    source: "rust-media-socket",
    target: "/run/hyori-media",
    read_only: true,
  });
  expect(permissions.network_mode).toBe("none");
  expect(permissions.volumes).toHaveLength(1);
  expect(permissions.volumes[0]?.source).toBe("rust-media-socket");
  expect(config.volumes["rust-media-socket"]?.name).toBe(
    "hyori-isolation-fixture_rust-media-socket",
  );

  for (const [name, entry] of Object.entries(config.services)) {
    if (name !== "web") expect(entry.ports).toEqual([]);
    else expect(entry.ports.every((port) => port.host_ip === "127.0.0.1")).toBe(true);
  }

  expect(Object.keys(config.services.web?.environment ?? {}).sort()).toEqual([
    "APP_ENV",
    "APP_ORIGIN",
    "HYORI_BACKEND_URL",
    "NODE_ENV",
  ]);
});
