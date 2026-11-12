import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { checkBackupSpace, InsufficientBackupSpace } from "./ops-backup-space.ts";

process.umask(0o077);

const root = "/backups";
const success = join(root, "last-success");
const failure = join(root, "last-failure");

function positiveInteger(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);

  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);

  return value;
}

const interval = positiveInteger("HYORI_BACKUP_INTERVAL_SECONDS", 86400);
const maxAge = positiveInteger("HYORI_BACKUP_MAX_AGE_SECONDS", 90000);
const keep = positiveInteger("HYORI_BACKUP_KEEP", 7);
const timeoutSeconds = positiveInteger("HYORI_BACKUP_TIMEOUT_SECONDS", 3600);

if (maxAge <= interval) throw new Error("Backup max age must exceed its interval.");

if (process.argv.includes("--health")) {
  try {
    checkBackupSpace(root);
    const last = existsSync(success) ? Number(readFileSync(success, "utf8")) : 0;
    process.exit(!existsSync(failure) && last > 0 && Date.now() - last < maxAge * 1000 ? 0 : 1);
  } catch {
    process.exit(1);
  }
}

mkdirSync(root, { recursive: true, mode: 0o700 });

chmodSync(root, 0o700);

// A killed backup never publishes its partial directory. Clear partials on restart, not good backups.
for (const name of readdirSync(root)) {
  if (/^\.partial-\d+$/.test(name)) rmSync(join(root, name), { recursive: true });
}

const envFile = "/tmp/backup.env";

const keys = [
  "APP_ENV",
  "APP_ORIGIN",
  "HYORI_WEB_PORT",
  "POSTGRES_PASSWORD",
  "HYORI_DATABASE_URL",
  "HYORI_SETUP_TOKEN",
  "HYORI_AUTH_SECRET",
  "HYORI_STORAGE_BUCKET",
  "HYORI_STORAGE_ACCESS_KEY",
  "HYORI_STORAGE_SECRET_KEY",
];

const values = keys.map((key) => {
  const value = process.env[key] ?? "";

  if (/[\r\n]/.test(value)) throw new Error(`Invalid newline in ${key}`);

  return `${key}=${value}`;
});

writeFileSync(envFile, `${values.join("\n")}\n`, { mode: 0o600 });

const backups = () =>
  readdirSync(root)
    .filter((name) => /^backup-\d+$/.test(name))
    .sort()
    .reverse();

for (;;) {
  const id = Date.now();
  const partial = join(root, `.partial-${id}`);
  let status = "failed";

  try {
    checkBackupSpace(root);
    const previous = backups()[0];

    const child = spawn(
      "bun",
      [
        "/app/ops-backup.js",
        "backup",
        partial,
        "--direct",
        "true",
        "--env-file",
        envFile,
        ...(previous ? ["--previous", join(root, previous)] : []),
      ],
      { stdio: "inherit", detached: true },
    );

    const timeout = setTimeout(() => {
      console.error('{"event":"scheduled_backup","status":"timeout"}');
      writeFileSync(failure, String(Date.now()), { mode: 0o600 });
      // Container exit terminates all descendants; restart clears unpublished partials.
      process.exit(1);
    }, timeoutSeconds * 1000);

    let lowSpace = false;

    const watch = setInterval(() => {
      if (lowSpace) return;

      try {
        checkBackupSpace(root);
      } catch {
        lowSpace = true;

        // Kill this run's process group, including a blocked pg_dump or S3 reader.
        try {
          if (child.pid) process.kill(-child.pid, "SIGTERM");
        } catch (error) {
          if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
        }
      }
    }, 250);

    let code: number | null;

    try {
      code = await new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("exit", resolve);
      });
    } finally {
      clearTimeout(timeout);
      clearInterval(watch);
    }

    if (lowSpace || code === 75) throw new InsufficientBackupSpace();

    if (code !== 0) throw new Error("Backup failed");
    checkBackupSpace(root);
    renameSync(partial, join(root, `backup-${id}`));

    // Prune only complete backups, and only after a new validated backup exists.
    for (const name of backups().slice(keep)) rmSync(join(root, name), { recursive: true });
    writeFileSync(`${success}.tmp`, String(Date.now()), { mode: 0o600 });
    renameSync(`${success}.tmp`, success);
    rmSync(failure, { force: true });
    status = "ok";
  } catch (error) {
    status = error instanceof InsufficientBackupSpace ? "insufficient_space" : "failed";
    console.error(JSON.stringify({ event: "scheduled_backup", status }));
    rmSync(partial, { recursive: true, force: true });
    writeFileSync(failure, String(Date.now()), { mode: 0o600 });
  }

  if (status === "ok") console.log('{"event":"scheduled_backup","status":"ok"}');
  await Bun.sleep(interval * 1000);
}
