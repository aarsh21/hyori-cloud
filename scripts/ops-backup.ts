// Online backup and offline-target restore of a Hyori Compose deployment. See docs/backup-restore.md.
//
//   bun scripts/ops-backup.ts backup  <dir> [--project hyori-cloud-rust] [--env-file .env.deployment]
//   bun scripts/ops-backup.ts restore <dir> --project <fresh-project> --env-file <env for the new stack>
//
// Backup, while the stack serves traffic:
//   1. copy every object from the bucket (reuse immutable files in scheduled snapshots);
//   2. pg_dump one consistent PostgreSQL snapshot;
//   3. copy objects again, picking up objects committed before the snapshot but after pass 1;
//   4. read every object key the snapshot references (current files, retained versions and ready
//      thumbnails) and fail unless each one is present in the backup.
// Object keys are unique, immutable and never rewritten, so a key copied in either pass holds exactly
// the bytes the snapshot refers to. Objects released after the snapshot can only be deleted from the
// bucket, never from the backup. After validation, scheduled snapshots unlink only unreferenced keys;
// manual copies can keep harmless orphans. Older snapshots' linked files are never overwritten.
//
// Restore needs a project with no existing volumes: it starts only PostgreSQL and RustFS, restores the
// dump in one transaction, uploads the objects, then starts the backend and web host.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { z } from "zod";
import { options } from "./ops-client.ts";
import { checkBackupSpace, InsufficientBackupSpace } from "./ops-backup-space.ts";

// rclone 1.71, pinned by digest: the only image this tool adds to the deployment.
const RCLONE =
  "rclone/rclone@sha256:3103526c506266a9ecdf064efe99bf3677d92ef6407af124d8c56b4f49cbaa51";

const args = options();
const [command, target] = args.positional;

if (!target || (command !== "backup" && command !== "restore"))
  throw new Error("Usage: ops-backup.ts backup|restore <dir> [--project …] [--env-file …]");

const dir = resolve(target);
const project = args.get("project", command === "backup" ? "hyori-cloud-rust" : undefined);
const envFile = resolve(args.get("env-file", ".env.deployment"));
const env = parseEnv(envFile);

// The scheduled container talks to the private services directly, without a Docker socket.
const direct = args.get("direct", "false") === "true";
const started = performance.now();

const storageEnv = {
  RCLONE_CONFIG: "/tmp/none.conf",
  RCLONE_CONFIG_HYORI_TYPE: "s3",
  RCLONE_CONFIG_HYORI_PROVIDER: "Other",
  RCLONE_CONFIG_HYORI_ENDPOINT: "http://rustfs:9000",
  RCLONE_CONFIG_HYORI_FORCE_PATH_STYLE: "true",
  RCLONE_CONFIG_HYORI_REGION: "us-east-1",
  RCLONE_CONFIG_HYORI_ACCESS_KEY_ID: env.HYORI_STORAGE_ACCESS_KEY!,
  RCLONE_CONFIG_HYORI_SECRET_ACCESS_KEY: env.HYORI_STORAGE_SECRET_KEY!,
};

function parseEnv(path: string) {
  const values: Record<string, string> = {};

  for (const line of readFileText(path).split("\n")) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());

    if (match) values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }

  return values;
}

function readFileText(path: string) {
  return readFileSync(path, "utf8");
}

function log(message: string) {
  process.stdout.write(`[${((performance.now() - started) / 1000).toFixed(1)}s] ${message}\n`);
}

function run(file: string, argv: string[], extraEnv: Record<string, string> = {}) {
  return execFileSync(file, argv, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 256 * 1024 * 1024,
  }).trim();
}

function compose(argv: string[]) {
  return run("docker", ["compose", "--project-name", project, "--env-file", envFile, ...argv]);
}

function container(service: string) {
  if (direct) return service;
  const id = compose(["ps", "--quiet", service]);

  if (!id) throw new Error(`Service ${service} of project ${project} is not running.`);

  return id;
}

/** rclone against the deployment's private RustFS endpoint; credentials pass by environment name only. */
function rclone(argv: string[]) {
  if (direct) return run("rclone", argv, storageEnv);

  return run(
    "docker",
    [
      "run",
      "--rm",
      "--network",
      `${project}_default`,
      "--user",
      `${process.getuid!()}:${process.getgid!()}`,
      "--read-only",
      "--tmpfs",
      "/tmp",
      "-e",
      "HOME=/tmp",
      "-e",
      "RCLONE_CONFIG=/tmp/none.conf",
      "-e",
      "RCLONE_CONFIG_HYORI_TYPE=s3",
      "-e",
      "RCLONE_CONFIG_HYORI_PROVIDER=Other",
      "-e",
      "RCLONE_CONFIG_HYORI_ENDPOINT=http://rustfs:9000",
      "-e",
      "RCLONE_CONFIG_HYORI_FORCE_PATH_STYLE=true",
      "-e",
      "RCLONE_CONFIG_HYORI_REGION=us-east-1",
      "-e",
      "RCLONE_CONFIG_HYORI_ACCESS_KEY_ID",
      "-e",
      "RCLONE_CONFIG_HYORI_SECRET_ACCESS_KEY",
      "-v",
      `${join(dir, "objects")}:/backup`,
      RCLONE,
      ...argv,
    ],
    {
      RCLONE_CONFIG_HYORI_ACCESS_KEY_ID: env.HYORI_STORAGE_ACCESS_KEY!,
      RCLONE_CONFIG_HYORI_SECRET_ACCESS_KEY: env.HYORI_STORAGE_SECRET_KEY!,
    },
  );
}

function postgresCommand(postgres: string, argv: string[], stdin = false) {
  return direct ? argv : ["docker", "exec", ...(stdin ? ["-i"] : []), postgres, ...argv];
}

function bucket() {
  const name = env.HYORI_STORAGE_BUCKET;

  if (!name) throw new Error(`HYORI_STORAGE_BUCKET is missing from ${envFile}.`);

  return name;
}

/** Stream a command's stdout to a file or a file to its stdin without buffering either in memory. */
async function pipe(
  argv: string[],
  io: { stdout?: string; stdin?: string },
  extraEnv: Record<string, string> = {},
) {
  const childEnv = { ...process.env, ...extraEnv };

  if (direct) {
    childEnv.PGHOST = "postgres";
    childEnv.PGPASSWORD = env.POSTGRES_PASSWORD;
  }

  const guarded = direct && io.stdout;

  if (guarded) checkBackupSpace(dir);

  const child = Bun.spawn(argv, {
    env: childEnv,
    stdin: io.stdin ? Bun.file(io.stdin) : "ignore",
    stdout: guarded ? "pipe" : io.stdout ? Bun.file(io.stdout) : "inherit",
    stderr: "inherit",
  });

  if (guarded) {
    let fd: number | undefined;

    try {
      // Never truncate or rewrite a reused inode. Only newly downloaded objects and the dump write.
      fd = openSync(guarded, "wx", 0o600);

      // SAFETY: guarded selected stdout: "pipe" above; Bun's union type also includes non-pipe fds.
      for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
        for (let offset = 0; offset < chunk.byteLength;) {
          const part = chunk.subarray(offset, offset + 65536);
          checkBackupSpace(dir, part.byteLength);
          offset += writeSync(fd, part);
        }
      }
    } catch (error) {
      child.kill();
      await child.exited;
      throw error;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
  }

  if ((await child.exited) !== 0) throw new Error(`${argv.slice(0, 4).join(" ")} … failed`);
}

function walk(root: string): string[] {
  if (!existsSync(root)) return [];

  return readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

/** Object keys referenced by the dump, read from its COPY data rather than from the live database. */
async function referencedKeys(postgres: string, dump: string) {
  const child = Bun.spawn(
    postgresCommand(
      postgres,
      [
        "pg_restore",
        "--data-only",
        "--table=hyori_items",
        "--table=hyori_versions",
        "--table=hyori_media_artifacts",
        "--file=-",
      ],
      true,
    ),
    { stdin: Bun.file(dump), stdout: "pipe", stderr: "inherit" },
  );

  const text = await new Response(child.stdout).text();

  if ((await child.exited) !== 0) throw new Error("pg_restore could not read the dump.");
  const keys = new Set<string>();
  let columns: string[] | null = null;
  let table = "";

  for (const line of text.split("\n")) {
    const header = /^COPY public\.(\w+) \(([^)]*)\) FROM stdin;$/.exec(line);

    if (header) {
      table = header[1]!;
      columns = header[2]!.split(", ");
      continue;
    }

    if (line === "\\.") {
      columns = null;
      continue;
    }

    if (!columns) continue;
    const row = line.split("\t");
    const value = (name: string) => row[columns!.indexOf(name)];
    const key = value("object_key");

    if (!key || key === "\\N") continue;

    if (table === "hyori_media_artifacts" && value("state") !== "ready") continue;
    keys.add(key);
  }

  return keys;
}

async function sha256(path: string) {
  const hash = createHash("sha256");

  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);

  return hash.digest("hex");
}

/** Scheduled copies have one guarded writer; rclone reads S3 but never writes linked local files. */
async function copyObjects() {
  if (!direct) {
    rclone(["copy", `hyori:${bucket()}`, "/backup"]);

    return;
  }

  const listed = z
    .array(z.object({ Path: z.string(), Size: z.number().int().nonnegative() }))
    .parse(JSON.parse(rclone(["lsjson", "--recursive", "--files-only", `hyori:${bucket()}`])));

  for (const object of listed) {
    const path = join(dir, "objects", object.Path);

    if (existsSync(path)) {
      if (statSync(path).size !== object.Size) throw new Error("Immutable object size changed.");
      continue;
    }

    checkBackupSpace(dir, object.Size);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    await pipe(["rclone", "cat", `hyori:${bucket()}/${object.Path}`], { stdout: path }, storageEnv);

    if (statSync(path).size !== object.Size) throw new Error("Object copy is incomplete.");
  }
}

async function backup() {
  if (existsSync(dir) && readdirSync(dir).length) throw new Error(`${dir} is not empty.`);

  if (direct) checkBackupSpace(dirname(dir));
  mkdirSync(join(dir, "objects"), { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const previous = args.get("previous", "");

  if (direct && previous) {
    const source = join(previous, "objects");

    for (const key of walk(source)) {
      checkBackupSpace(dir);
      const path = join(dir, "objects", key);
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      linkSync(join(source, key), path);
    }
  }

  const postgres = container("postgres");
  container("rustfs");
  log(`object pass 1: s3://${bucket()} → objects/`);
  await copyObjects();
  const pass1 = walk(join(dir, "objects")).length;
  log(`object pass 1 copied ${pass1} objects; dumping PostgreSQL`);
  // Work acknowledged before this instant is in the snapshot; later work may or may not be.
  const snapshotStartedAt = new Date().toISOString();
  const dump = join(dir, "postgres.dump");
  await pipe(
    postgresCommand(postgres, ["pg_dump", "--username=hyori", "--dbname=hyori", "--format=custom"]),
    { stdout: dump },
  );
  log(`pg_dump wrote ${statSync(dump).size} bytes; object pass 2`);
  await copyObjects();
  let objects = walk(join(dir, "objects"));
  const present = new Set(objects);
  const keys = await referencedKeys(postgres, dump);
  const missing = [...keys].filter((key) => !present.has(key));

  if (missing.length)
    throw new Error(
      `Backup is NOT consistent: ${missing.length} referenced objects are missing, e.g. ${missing.slice(0, 3).join(", ")}`,
    );

  if (direct) {
    // A new snapshot owns exactly its referenced keys. Unlinking never touches older snapshots.
    for (const key of objects) {
      if (!keys.has(key)) unlinkSync(join(dir, "objects", key));
    }

    objects = objects.filter((key) => keys.has(key));
  }

  const migrationCommand = postgresCommand(postgres, [
    "psql",
    "--username=hyori",
    "--dbname=hyori",
    "--tuples-only",
    "--no-align",
    "--command=SELECT max(version) FROM hyori_migrations",
  ]);

  const migrations = run(
    migrationCommand[0]!,
    migrationCommand.slice(1),
    direct
      ? {
          PGHOST: "postgres",
          PGPASSWORD: env.POSTGRES_PASSWORD!,
        }
      : {},
  );

  const images = direct
    ? {}
    : Object.fromEntries(
        ["postgres", "rustfs", "media-worker", "backend", "web"].map((service) => {
          const id = compose(["ps", "--quiet", service]);

          return [service, id ? run("docker", ["inspect", "--format", "{{.Image}}", id]) : null];
        }),
      );

  // The restored stack needs the same HYORI_AUTH_SECRET; the env file is as secret as the dump.
  if (direct) checkBackupSpace(dir, statSync(envFile).size);
  copyFileSync(envFile, join(dir, "env.deployment"));
  chmodSync(join(dir, "env.deployment"), 0o600);
  const bytes = objects.reduce((sum, key) => sum + statSync(join(dir, "objects", key)).size, 0);
  const dumpSha256 = await sha256(dump);

  const metadata = {
    createdAt: new Date().toISOString(),
    project,
    bucket: bucket(),
    snapshotStartedAt,
    schemaVersion: Number(migrations),
    images,
    dump: { file: "postgres.dump", bytes: statSync(dump).size, sha256: dumpSha256 },
    objects: {
      count: objects.length,
      bytes,
      referenced: keys.size,
      orphans: objects.length - keys.size,
    },
  };

  const metadataText = `${JSON.stringify(metadata, null, 2)}\n`;

  if (direct) checkBackupSpace(dir, Buffer.byteLength(metadataText));
  await Bun.write(join(dir, "backup.json"), metadataText);
  log(
    `BACKUP OK ${dir}: schema ${metadata.schemaVersion}, dump ${metadata.dump.bytes} B, ` +
      `${objects.length} objects (${bytes} B), all ${keys.size} referenced keys present`,
  );
}

async function waitFor(check: () => boolean, what: string, seconds = 120) {
  const deadline = Date.now() + seconds * 1000;

  while (Date.now() < deadline) {
    try {
      if (check()) return;
    } catch {
      // Not ready yet.
    }

    await Bun.sleep(1000);
  }

  throw new Error(`${what} did not become ready in ${seconds}s.`);
}

async function restore() {
  const metadata = await Bun.file(join(dir, "backup.json")).json();
  const dump = join(dir, "postgres.dump");
  const dumpSha256 = await sha256(dump);

  if (dumpSha256 !== metadata.dump.sha256)
    throw new Error("postgres.dump does not match backup.json.");

  const existing = run("docker", [
    "volume",
    "ls",
    "--quiet",
    "--filter",
    `label=com.docker.compose.project=${project}`,
  ]);

  if (existing)
    throw new Error(`Project ${project} already has volumes; restore only into a fresh project.`);
  log(`starting PostgreSQL and RustFS for fresh project ${project}`);
  compose(["up", "--detach", "--wait", "--no-build", "postgres", "rustfs"]);
  const postgres = container("postgres");
  const rustfs = container("rustfs");
  await waitFor(
    () => run("docker", ["exec", rustfs, "curl", "-fsS", "http://127.0.0.1:9000/health"]) !== null,
    "RustFS",
  );

  const tables = run("docker", [
    "exec",
    postgres,
    "psql",
    "--username=hyori",
    "--dbname=hyori",
    "--tuples-only",
    "--no-align",
    "--command=SELECT count(*) FROM information_schema.tables WHERE table_schema='public'",
  ]);

  if (tables !== "0") throw new Error("The new database is not empty.");
  log("restoring PostgreSQL in one transaction");
  await pipe(
    [
      "docker",
      "exec",
      "-i",
      postgres,
      "pg_restore",
      "--username=hyori",
      "--dbname=hyori",
      "--no-owner",
      "--single-transaction",
      "--exit-on-error",
    ],
    { stdin: dump },
  );
  log(`uploading ${metadata.objects.count} objects to s3://${bucket()}`);
  rclone(["mkdir", `hyori:${bucket()}`]);
  rclone(["copy", "/backup", `hyori:${bucket()}`]);

  const { count: listed } = z
    .object({ count: z.number() })
    .parse(JSON.parse(rclone(["size", "--json", `hyori:${bucket()}`])));

  if (listed !== metadata.objects.count)
    throw new Error(`Bucket holds ${listed} objects, backup has ${metadata.objects.count}.`);
  log("starting the backend and web host");
  compose(["up", "--detach", "--wait", "--no-build", "backend", "web"]);
  // A large first backup can outlast its health startup grace; it must not block app recovery.
  compose(["up", "--detach", "--no-build", "backup"]);
  log(`RESTORE OK into ${project}: schema ${metadata.schemaVersion}, ${listed} objects`);
}

if (direct && command !== "backup") throw new Error("Direct mode only supports backup.");

try {
  if (command === "backup") await backup();
  else await restore();
} catch (error) {
  if (!(error instanceof InsufficientBackupSpace)) throw error;
  console.error('{"event":"backup","status":"insufficient_space"}');
  process.exit(75);
}
