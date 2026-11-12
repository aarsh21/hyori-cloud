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

if (maxAge <= interval) throw new Error("Backup max age must exceed its interval.");

if (process.argv.includes("--health")) {
  const last = existsSync(success) ? Number(readFileSync(success, "utf8")) : 0;
  process.exit(!existsSync(failure) && last > 0 && Date.now() - last < maxAge * 1000 ? 0 : 1);
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

for (;;) {
  const id = Date.now();
  const partial = join(root, `.partial-${id}`);

  const child = Bun.spawn(
    ["bun", "/app/ops-backup.js", "backup", partial, "--direct", "true", "--env-file", envFile],
    { stdout: "inherit", stderr: "inherit" },
  );

  const timeout = setTimeout(
    () => {
      writeFileSync(failure, String(Date.now()), { mode: 0o600 });
      console.error('{"event":"scheduled_backup","status":"timeout"}');
      // Exiting the container terminates pg_dump/rclone descendants too; restart clears partials.
      process.exit(1);
    },
    positiveInteger("HYORI_BACKUP_TIMEOUT_SECONDS", 3600) * 1000,
  );

  let ok = (await child.exited) === 0;
  clearTimeout(timeout);

  try {
    if (!ok) throw new Error("Backup failed");
    renameSync(partial, join(root, `backup-${id}`));

    // Prune only complete backups, and only after a new validated backup exists.
    const backups = readdirSync(root)
      .filter((name) => /^backup-\d+$/.test(name))
      .sort()
      .reverse();

    for (const name of backups.slice(keep)) rmSync(join(root, name), { recursive: true });
    writeFileSync(`${success}.tmp`, String(Date.now()), { mode: 0o600 });
    renameSync(`${success}.tmp`, success);
    rmSync(failure, { force: true });
  } catch {
    ok = false;
    writeFileSync(failure, String(Date.now()), { mode: 0o600 });
    rmSync(partial, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ event: "scheduled_backup", status: ok ? "ok" : "failed" }));
  await Bun.sleep(interval * 1000);
}
