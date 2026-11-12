// Continuous user activity through the public SDK, for backups and failure drills.
//
//   bun scripts/ops-churn.ts [check] --origin … --ca … --manifest m.json --log churn.jsonl [--seconds 60]
//       [--size-kib 2048] [--workers 2]
//
// Each worker loops: upload a fresh random file, replace every third one (creating a version), trash
// every fifth, and download-verify every completed upload. Every outcome, including the error code a
// user would see, is appended to the JSONL log; `check` re-reads every logged completed file and
// reports any whose bytes differ or which disappeared.
// `check` appends nothing; run it after a drill, backup or restore. `--before <ISO time>` limits
// it to operations acknowledged before then, such as a backup's snapshot.
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  login,
  diskFile,
  clientError,
  describe,
  readChurnLog,
  readManifest,
  type ChurnEntry,
  hashStream,
  options,
  writeRandomFile,
  type Session,
} from "./ops-client.ts";

const args = options();
const gateway = args.gateway();

const manifest = await readManifest(args.get("manifest"));

const logPath = args.get("log");

const signIn = () => login(gateway, manifest.owner.email, manifest.owner.password);

async function check() {
  const latest = new Map<string, { sha256: string; trashed: boolean }>();
  // After a restore, only work acknowledged before the backup's database snapshot can be expected.
  const before = args.get("before", "9999");

  // A change acknowledged after the cutoff may or may not be in a snapshot taken a moment later.
  const unsettled = new Set<string>();

  for (const entry of readChurnLog(logPath)) {
    if (entry.ok && entry.id && entry.at > before && entry.op !== "download") unsettled.add(entry.id);

    if (!entry.ok || !entry.id || entry.at > before) continue;

    if (entry.op === "upload" || entry.op === "replace")
      latest.set(entry.id, { sha256: entry.sha256!, trashed: false });

    if (entry.op === "trash") latest.get(entry.id)!.trashed = true;
  }

  const session = await signIn();
  const problems: string[] = [];
  let verified = 0;

  for (const id of unsettled) latest.delete(id);

  for (const [id, expected] of latest) {
    if (expected.trashed) continue;

    try {
      const opened = await session.sdk.downloads.open({ id });
      const read = await hashStream(opened.stream);

      if (read.sha256 !== expected.sha256) problems.push(`${id}: bytes differ`);
      else verified++;
    } catch (error) {
      problems.push(`${id}: ${describe(clientError(error)).code}`);
    }
  }

  session.sdk.dispose();
  process.stdout.write(
    `CHURN CHECK ${verified}/${[...latest.values()].filter((value) => !value.trashed).length} acknowledged files intact` +
      (unsettled.size ? ` (${unsettled.size} files changed after --before skipped)` : "") +
      (problems.length ? `; ${problems.length} problems:\n${problems.join("\n")}\n` : "\n"),
  );

  if (problems.length) process.exit(1);
}

async function worker(index: number, folderId: string, deadline: number, scratch: string) {
  let session: Session = await signIn();
  let round = 0;

  const record = (entry: Omit<ChurnEntry, "at" | "worker">) =>
    appendFileSync(
      logPath,
      `${JSON.stringify({ at: new Date().toISOString(), worker: index, ...entry })}\n`,
    );

  async function timed<T>(
    op: ChurnEntry["op"],
    body: () => Promise<T>,
    extra: (value: T) => Partial<ChurnEntry>,
  ) {
    const start = performance.now();

    try {
      const value = await body();
      record({ op, ok: true, ms: Math.round(performance.now() - start), ...extra(value) });

      return value;
    } catch (error) {
      const { code, message } = describe(clientError(error));
      record({
        op,
        ok: false,
        ms: Math.round(performance.now() - start),
        error: code,
        detail: message,
      });

      // A restarted backend keeps sessions; only an expired session needs a fresh login.
      if (code === "auth.required") session = await signIn().catch(() => session);

      await Bun.sleep(500);

      return null;
    }
  }

  while (Date.now() < deadline) {
    round++;
    const path = join(scratch, `w${index}-${round}.bin`);
    const sha256 = await writeRandomFile(path, Number(args.get("size-kib", "2048")) * 1024 + round);
    const name = `churn-${index}-${round}-${randomBytes(3).toString("hex")}.bin`;

    const entry = await timed(
      "upload",
      () => session.sdk.uploads.start({ parentId: folderId, file: diskFile(path, name) }).result,
      (value) => ({ id: value.id, sha256 }),
    );

    if (!entry) continue;
    await timed(
      "download",
      async () => {
        const read = await hashStream((await session.sdk.downloads.open({ id: entry.id })).stream);

        if (read.sha256 !== sha256) throw new Error("downloaded bytes differ from the upload");
      },
      () => ({ id: entry.id }),
    );

    if (round % 3 === 0) {
      const replacement = join(scratch, `w${index}-${round}-r.bin`);
      const replacedSha = await writeRandomFile(replacement, 512 * 1024 + round);
      await timed(
        "replace",
        () =>
          session.sdk.uploads.replace({
            parentId: folderId,
            file: diskFile(replacement, name),
            target: { id: entry.id, name },
          }).result,
        () => ({ id: entry.id, sha256: replacedSha }),
      );
    }

    if (round % 5 === 0)
      await timed(
        "trash",
        () => session.sdk.rpc.files.trash({ id: entry.id }),
        () => ({ id: entry.id }),
      );
  }

  session.sdk.dispose();
}

if (args.positional[0] === "check") await check();
else {
  const seconds = Number(args.get("seconds", "60"));
  const workers = Number(args.get("workers", "2"));
  const scratch = `/tmp/hyori-churn-${process.pid}`;
  mkdirSync(scratch, { recursive: true });
  const setup = await signIn();
  const folders = await setup.sdk.rpc.files.list({ parentId: null, limit: 100 });

  const folder =
    folders.items.find((item) => item.name === "Churn" && item.kind === "folder") ??
    (await setup.sdk.rpc.files.createFolder({ parentId: null, name: "Churn" }));

  setup.sdk.dispose();
  const deadline = Date.now() + seconds * 1000;
  await Promise.all(
    Array.from({ length: workers }, (_, index) => worker(index, folder.id, deadline, scratch)),
  );

  const entries = readChurnLog(logPath);

  const failed = entries.filter((entry) => !entry.ok);
  process.stdout.write(
    `CHURN ${entries.length} operations, ${failed.length} failed` +
      (failed.length
        ? ` (${[...new Set(failed.map((entry) => `${entry.op}:${entry.error} (${entry.detail ?? ""})`))].join(", ")})`
        : "") +
      "\n",
  );
}
