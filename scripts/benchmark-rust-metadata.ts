import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir, cpus, totalmem, loadavg, release } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { createClient, InputOf, OutputOf } from "@hyori-cloud/client-sdk";
import { z } from "zod";

export const conditions = {
  image: "hyori-rust-verification:uploads-t3-ce2b2e51",
  expectedImageId: "sha256:f80c86dcb9aa437fc13fc7fc16f17cad65105ad3e8932e812760d034b5c51c9a",
  postgres: "postgres:17",
  rustfs: "rustfs/rustfs:1.0.0-alpha.85",
  samplesPerJourney: 100,
  warmupPerJourney: 3,
  concurrency: 10,
  pageSize: 100,
  items: 100_000,
  accounts: 10,
  incomingGrants: 1201,
  candidateListingP95Ms: 150,
  candidateSearchP95Ms: 300,
  requestTimeoutMs: 35_000,
  scope:
    "Current-host characterization only; target devices/deployment unagreed. No supported capacity or NAS extrapolation.",
  limits: "No CPU/memory/cpuset limits; NOT a 2-CPU/4-GiB complete-stack simulation.",
  concurrentHostWork:
    "Parent reports Photos Rust/SDK compilation, isolated Deck WASM build and Docker acceptance fixtures on this host. Overlap is uncontrolled; resource snapshots are not per-sample attribution.",
  imageScope:
    "Pinned image predates the parent's subsequent grant-continuity fix; these results are not current-source performance or security acceptance.",
  cold: "First sequential pass after PostgreSQL/server restart. OS/storage caches NOT flushed; not a cold-cache measurement.",
  timing:
    "SDK encode + in-process owned Fetch proxy + real loopback HTTP + release server/DB + SDK decode. No client-to-proxy socket or TLS.",
  concurrencyModel:
    "Ten independent SDK consumers of the same journey/account, ten requests each; closed loop, no think time. Not open-loop capacity.",
  exclusions:
    "Browser/render/INP/navigation, WAN/TLS, original bytes/downloads/uploads, Photos endpoints, versions/trash and full-stack mixed-transfer capacity.",
} as const;

type Client = ReturnType<typeof createClient>;

type ListInput = InputOf<Client["rpc"]["files"]["list"]>;

type ListResult = OutputOf<Client["rpc"]["files"]["list"]>;

export type TimingRow = {
  phase: "restart-first-pass" | "warm-sequential" | "warm-concurrent";
  journey: string;
  sample: number;
  worker: number;
  startedAt: string;
  elapsedMs: number;
  ok: boolean;
  rows: number | null;
  idDigest: string | null;
  errorCode: string | null;
};

export function percentile(values: readonly number[], quantile: number) {
  assert.ok(values.length > 0 && quantile > 0 && quantile <= 1);
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0));
  const ordered = [...values].sort((a, b) => a - b);

  return ordered[Math.ceil(ordered.length * quantile) - 1]!;
}

export function summarize(rows: readonly TimingRow[], budgetMs: number) {
  const durations = rows.map((row) => row.elapsedMs);

  return {
    samples: rows.length,
    failures: rows.filter((row) => !row.ok).length,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    maxMs: Math.max(...durations),
    budgetMs,
    passesCandidate: rows.every((row) => row.ok) && percentile(durations, 0.95) <= budgetMs,
    quantile: "nearest rank; failed/timed-out requests retained" as const,
  };
}

export function itemId(sequence: number) {
  return `item_${String(sequence).padStart(6, "0")}`;
}

export const journeys = [
  { name: "root-100", actor: 0, input: { parentId: null, limit: 100 }, count: 100 },
  { name: "root-1000", actor: 1, input: { parentId: null, limit: 100 }, count: 100 },
  { name: "root-10000", actor: 2, input: { parentId: null, limit: 100 }, count: 100 },
  { name: "folder-100", actor: 0, input: { parentId: itemId(1), limit: 100 }, count: 100 },
  { name: "folder-1000", actor: 0, input: { parentId: itemId(2), limit: 100 }, count: 100 },
  { name: "folder-10000", actor: 0, input: { parentId: itemId(3), limit: 100 }, count: 100 },
  {
    name: "folder-10000-page2",
    actor: 0,
    input: { parentId: itemId(3), cursor: itemId(1300), limit: 100 },
    count: 100,
  },
  {
    name: "inherited-folder-10000",
    actor: 9,
    input: { parentId: itemId(3), limit: 100 },
    count: 100,
  },
  { name: "shared-1201-grants", actor: 9, input: { view: "shared", limit: 100 }, count: 100 },
  { name: "search-private", actor: 0, input: { search: "report", limit: 100 }, count: 100 },
  {
    name: "search-shared",
    actor: 9,
    input: { view: "shared", search: "report", limit: 100 },
    count: 100,
  },
  {
    name: "filter-image-date-size",
    actor: 0,
    input: {
      parentId: itemId(3),
      type: "image",
      after: "2026-03-01T00:00:00.000Z",
      before: "2026-11-01T00:00:00.000Z",
      minSize: 1024,
      maxSize: 1048576,
      limit: 100,
    },
    count: 100,
  },
  {
    name: "private-name-denied",
    actor: 9,
    input: { search: "private-owner5-secret", limit: 100 },
    count: 0,
  },
] satisfies { name: string; actor: number; input: ListInput; count: number }[];

type Journey = (typeof journeys)[number];

/** Fixture-only SQL. Timed operations always use the public SDK; this creates no original bytes. */
export function seedItemsSql() {
  return `
INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids,created_at,updated_at)
SELECT 'item_'||lpad(g::text,6,'0'), 'bench_user_'||owner,
 CASE WHEN g BETWEEN 101 AND 200 THEN 'item_000001'
      WHEN g BETWEEN 201 AND 1200 THEN 'item_000002'
      WHEN g BETWEEN 1201 AND 11200 THEN 'item_000003' ELSE NULL END,
 CASE WHEN g<=3 THEN 'folder-'||g WHEN g=50000 THEN 'private-owner5-secret'
      ELSE (CASE WHEN g%7=0 THEN 'report-' ELSE 'document-' END)||g END,
 CASE WHEN g<=3 THEN 'folder' ELSE 'file' END,
 CASE WHEN g<=3 THEN 0 ELSE ((g%2048)+1)*1024 END,
 CASE WHEN g<=3 THEN 'inode/directory' WHEN g%5=0 THEN 'image/jpeg' ELSE 'application/pdf' END,
 CASE WHEN g BETWEEN 101 AND 200 THEN '["item_000001"]'::jsonb
      WHEN g BETWEEN 201 AND 1200 THEN '["item_000002"]'::jsonb
      WHEN g BETWEEN 1201 AND 11200 THEN '["item_000003"]'::jsonb ELSE '[]'::jsonb END,
 '2026-01-01'::timestamptz + (g%365)*interval '1 day',
 '2026-01-01'::timestamptz + (g%365)*interval '1 day'
FROM (SELECT g, CASE WHEN g<=11200 THEN 0 WHEN g<=12200 THEN 1 WHEN g<=22200 THEN 2
 ELSE least(9,3+(g-22201)/11114) END AS owner FROM generate_series(1,100000) g) fixture;
INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role)
SELECT 'bench_share_'||g,'item_'||lpad(g::text,6,'0'),'bench_user_2','bench_user_9',false,'viewer'
FROM generate_series(12201,13400) g;
INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role)
VALUES ('bench_inherited','item_000003','bench_user_0','bench_user_9',false,'contributor');
ANALYZE hyori_users; ANALYZE hyori_sessions; ANALYZE hyori_items; ANALYZE hyori_shares;
`;
}

export function fixtureOwner(sequence: number) {
  assert.ok(Number.isInteger(sequence) && sequence >= 1 && sequence <= conditions.items);

  if (sequence <= 11200) return 0;

  if (sequence <= 12200) return 1;

  if (sequence <= 22200) return 2;

  return Math.min(9, 3 + Math.floor((sequence - 22201) / 11114));
}

function assertPage(page: ListResult, journey: Journey) {
  assert.equal(page.items.length, journey.count);
  assert.ok(page.items.length <= conditions.pageSize);
  const ids = page.items.map((item) => item.id);
  assert.deepEqual(ids, [...ids].sort());
  assert.equal(new Set(ids).size, ids.length);

  if (journey.name === "root-100" || journey.name === "folder-100" || journey.count === 0)
    assert.equal(page.nextCursor, null);
  else assert.equal(page.nextCursor, ids.at(-1));

  const cursor = journey.input.cursor;

  if (cursor) assert.ok(ids.every((id) => id > cursor));

  for (const item of page.items) {
    assert.equal(item.access.canDownload, true);
    const sequence = Number(item.id.slice("item_".length));
    assert.equal(item.id, itemId(sequence));
    const owner = fixtureOwner(sequence);
    assert.equal(item.ownerId, `bench_user_${owner}`);
    const owned = owner === journey.actor;

    const granted =
      journey.actor === 9 &&
      ((sequence >= 1201 && sequence <= 11200) ||
        sequence === 3 ||
        (sequence >= 12201 && sequence <= 13400));

    assert.ok(owned || granted, "response escaped synthetic authorized scope");
    assert.equal(item.access.isOwner, owned);

    if (journey.input.view === "shared") assert.equal(owned, false);

    if (journey.input.search) assert.ok(item.name.toLowerCase().includes(journey.input.search));

    if (journey.input.parentId) assert.equal(item.parentId, journey.input.parentId);

    if (journey.input.type) assert.ok(item.mimeType.startsWith(`${journey.input.type}/`));

    if (journey.input.minSize) assert.ok(item.size >= journey.input.minSize);

    if (journey.input.maxSize) assert.ok(item.size <= journey.input.maxSize);

    if (journey.input.after)
      assert.ok(Date.parse(item.updatedAt) >= Date.parse(journey.input.after));

    if (journey.input.before)
      assert.ok(Date.parse(item.updatedAt) <= Date.parse(journey.input.before));
  }

  return createHash("sha256").update(JSON.stringify(ids)).digest("hex");
}

const statSchema = z.object({
  queryid: z.string(),
  query: z.string(),
  calls: z.number(),
  rows: z.number(),
  total_exec_time: z.number(),
  total_plan_time: z.number(),
  plans: z.number(),
  shared_blks_hit: z.number(),
  shared_blks_read: z.number(),
  temp_blks_written: z.number(),
});

const statsSchema = z.array(statSchema);

export async function discoverConsumerPackages(packagesDirectory = "packages") {
  const pending = ["client-sdk", "api", "lib"];
  const found = new Set<string>();

  const manifestSchema = z.object({
    name: z.string(),
    dependencies: z.record(z.string(), z.string()).default({}),
  });

  const ownedName = z.string().regex(/^@hyori-cloud\/[a-z0-9-]+$/);

  for (let index = 0; index < pending.length; index++) {
    const name = pending[index]!;

    if (found.has(name)) continue;

    const manifest = manifestSchema.parse(
      JSON.parse(await readFile(join(packagesDirectory, name, "package.json"), "utf8")),
    );

    assert.equal(manifest.name, `@hyori-cloud/${name}`);
    found.add(name);

    for (const dependency of Object.keys(manifest.dependencies)) {
      if (dependency.startsWith("@hyori-cloud/"))
        pending.push(ownedName.parse(dependency).slice("@hyori-cloud/".length));
    }
  }

  return [...found];
}

export async function consumerSourceSnapshot() {
  const packages = await discoverConsumerPackages();
  const packageSchema = z.object({ name: z.string(), version: z.string() });
  const paths = ["bun.lock", ...packages.map((name) => `packages/${name}/package.json`)];

  async function visit(directory: string) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);

      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile() && /\.(?:ts|tsx|json)$/.test(entry.name)) paths.push(path);
    }
  }

  for (const name of packages) await visit(`packages/${name}/src`);
  const files: { path: string; sha256: string }[] = [];

  for (const path of paths.sort())
    files.push({
      path,
      sha256: createHash("sha256")
        .update(await readFile(path))
        .digest("hex"),
    });
  const versions: z.infer<typeof packageSchema>[] = [];

  for (const name of packages)
    versions.push(
      packageSchema.parse(JSON.parse(await readFile(`packages/${name}/package.json`, "utf8"))),
    );

  return {
    capturedAt: new Date().toISOString(),
    packageRoots: packages,
    versions,
    files,
    digest: createHash("sha256")
      .update(files.map(({ path, sha256 }) => `${sha256}  ${path}\n`).join(""))
      .digest("hex"),
  };
}

async function main() {
  const output = await mkdtemp(join(tmpdir(), "hyori-metadata-benchmark-"));
  await mkdir(join(output, "plans"));
  console.log(`Synthetic artifacts: ${output}`);
  console.log(JSON.stringify(conditions, null, 2));
  await writeFile(
    join(output, "conditions.json"),
    JSON.stringify(
      { ...conditions, journeys, fixedBeforeTimingAt: new Date().toISOString() },
      null,
      2,
    ),
  );
  const clientSources = await consumerSourceSnapshot();
  await writeFile(
    join(output, "client-source-before.json"),
    JSON.stringify(clientSources, null, 2),
  );

  const [{ createBackendProxy }, { createClient, normalizeClientError }] = await Promise.all([
    import("@hyori-cloud/api"),
    import("@hyori-cloud/client-sdk"),
  ]);

  assert.equal(
    (await consumerSourceSnapshot()).digest,
    clientSources.digest,
    "Consumer source changed while importing; no measurements were taken.",
  );

  const suffix = randomBytes(8).toString("hex");
  const network = `hyori-bench-net-${suffix}`;
  const postgres = `hyori-bench-pg-${suffix}`;
  const storage = `hyori-bench-fs-${suffix}`;
  const server = `hyori-bench-server-${suffix}`;
  const created: string[] = [];
  let networkCreated = false;
  const origin = "https://hyori-metadata-benchmark.test";
  const secret = () => randomBytes(32).toString("hex");
  const appPassword = secret();

  const env = {
    ...process.env,
    POSTGRES_PASSWORD: secret(),
    HYORI_SETUP_TOKEN: secret(),
    HYORI_AUTH_SECRET: secret(),
    RUSTFS_ACCESS_KEY: secret(),
    RUSTFS_SECRET_KEY: secret(),
  };

  const tokens = Array.from({ length: conditions.accounts }, secret);
  const clients: Client[] = [];

  function docker(args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
    return execFileSync("docker", args, {
      env: { ...env, ...extraEnv },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function sql(statement: string) {
    return execFileSync(
      "docker",
      [
        "exec",
        "-i",
        postgres,
        "psql",
        "-U",
        "hyori_bench",
        "-d",
        "hyori_bench",
        "-v",
        "ON_ERROR_STOP=1",
        "-qAt",
        "-f",
        "-",
      ],
      {
        input: statement,
        env,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
        stdio: ["pipe", "pipe", "pipe"],
      },
    ).trim();
  }

  async function waitUntil(check: () => Promise<boolean>, label: string) {
    const deadline = Date.now() + 90_000;

    while (Date.now() < deadline) {
      if (await check()) return;
      await new Promise((resolve) => setTimeout(resolve, 200));
    }

    throw new Error(`Disposable fixture readiness failed: ${label}`);
  }

  async function postgresReady() {
    await waitUntil(async () => {
      try {
        docker(["exec", postgres, "pg_isready", "-h", "127.0.0.1", "-U", "hyori_bench"]);

        return true;
      } catch {
        return false;
      }
    }, "PostgreSQL");
  }

  async function httpReady(url: string) {
    await waitUntil(async () => {
      try {
        return (await fetch(url, { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    }, "HTTP");
  }

  function address(name: string, port: string) {
    const result = docker(["port", name, port]);
    assert.match(result, /^127\.0\.0\.1:\d+$/);

    return `http://${result}`;
  }

  function queryStats() {
    return statsSchema.parse(
      JSON.parse(
        sql(`SELECT coalesce(json_agg(row_to_json(s)),'[]'::json) FROM (
 SELECT queryid::text,query,calls,rows,total_exec_time,total_plan_time,plans,shared_blks_hit,shared_blks_read,temp_blks_written
 FROM pg_stat_statements WHERE userid=(SELECT oid FROM pg_roles WHERE rolname='hyori_app') ORDER BY calls DESC,queryid) s;`),
      ),
    );
  }

  async function resources(label: string) {
    const snapshot = {
      label,
      at: new Date().toISOString(),
      load: loadavg(),
      meminfo: await readFile("/proc/meminfo", "utf8"),
      containers: docker([
        "stats",
        "--no-stream",
        "--format",
        "{{json .}}",
        postgres,
        storage,
        server,
      ]),
    };

    await appendFile(join(output, "resource-snapshots.ndjson"), `${JSON.stringify(snapshot)}\n`);
  }

  try {
    const imageId = docker(["image", "inspect", "--format", "{{.Id}}", conditions.image]);
    assert.equal(
      imageId,
      conditions.expectedImageId,
      "The tag no longer names the approved release image; do not silently benchmark another build.",
    );
    assert.equal(
      docker(["image", "inspect", "--format", "{{.Config.User}}", imageId]),
      "10001:10001",
    );

    const hardware = {
      cpu: cpus().map(({ model, speed }) => ({ model, speed })),
      totalMemoryBytes: totalmem(),
      kernel: release(),
      bun: Bun.version,
      dockerVersion: docker(["version", "--format", "{{.Server.Version}}"]),
      dockerInfo: docker([
        "info",
        "--format",
        "{{.Driver}} cgroup={{.CgroupVersion}} cpus={{.NCPU}} memory={{.MemTotal}} root={{.DockerRootDir}}",
      ]),
      lscpu: execFileSync("lscpu", { encoding: "utf8" }),
      storage: execFileSync("lsblk", ["-o", "NAME,MODEL,SIZE,ROTA,FSTYPE,MOUNTPOINTS"], {
        encoding: "utf8",
      }),
      dockerFilesystem: execFileSync(
        "findmnt",
        ["-T", "/var/lib/docker", "-o", "SOURCE,FSTYPE,TARGET,OPTIONS"],
        { encoding: "utf8" },
      ),
      images: {
        server: imageId,
        postgres: docker(["image", "inspect", "--format", "{{.Id}}", conditions.postgres]),
        rustfs: docker(["image", "inspect", "--format", "{{.Id}}", conditions.rustfs]),
      },
      gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      harnessSha256: createHash("sha256")
        .update(await readFile(import.meta.filename))
        .digest("hex"),
      sourceNote:
        "Release image is authoritative. Worktree is uncommitted and frozen source is not rebuilt.",
    };

    await writeFile(join(output, "environment.json"), JSON.stringify(hardware, null, 2));
    // Docker's internal networks on this host do not publish ports. Use an isolated bridge;
    // only the two explicit 127.0.0.1 bindings are reachable through host-published ports.
    docker(["network", "create", network]);
    networkCreated = true;
    docker([
      "run",
      "--detach",
      "--name",
      postgres,
      "--network",
      network,
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_USER=hyori_bench",
      "-e",
      "POSTGRES_DB=hyori_bench",
      conditions.postgres,
      "-c",
      "shared_preload_libraries=pg_stat_statements",
      "-c",
      "pg_stat_statements.track=all",
      "-c",
      "pg_stat_statements.track_planning=on",
      "-c",
      "log_parameter_max_length=0",
    ]);
    created.push(postgres);
    await postgresReady();
    sql(
      `CREATE ROLE hyori_app LOGIN PASSWORD '${appPassword}'; GRANT ALL ON DATABASE hyori_bench TO hyori_app; ALTER SCHEMA public OWNER TO hyori_app;`,
    );
    docker([
      "run",
      "--detach",
      "--name",
      storage,
      "--network",
      network,
      "-p",
      "127.0.0.1::9000",
      "--tmpfs",
      "/data:uid=10001,gid=10001",
      "--tmpfs",
      "/logs:uid=10001,gid=10001",
      "-e",
      "RUSTFS_ACCESS_KEY",
      "-e",
      "RUSTFS_SECRET_KEY",
      "-e",
      "RUSTFS_CONSOLE_ENABLE=false",
      conditions.rustfs,
      "/data",
    ]);
    created.push(storage);
    await httpReady(`${address(storage, "9000/tcp")}/health`);
    docker(
      [
        "run",
        "--detach",
        "--name",
        server,
        "--network",
        network,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs",
        "/tmp:rw,noexec,nosuid,size=16m",
        "-p",
        "127.0.0.1::3002",
        "-e",
        "APP_ENV=production",
        "-e",
        `APP_ORIGIN=${origin}`,
        "-e",
        "HYORI_DATABASE_URL",
        "-e",
        "HYORI_SETUP_TOKEN",
        "-e",
        "HYORI_AUTH_SECRET",
        "-e",
        `HYORI_STORAGE_ENDPOINT=http://${storage}:9000`,
        "-e",
        "HYORI_STORAGE_REGION=us-east-1",
        "-e",
        `HYORI_STORAGE_BUCKET=hyori-bench-${suffix}`,
        "-e",
        "HYORI_STORAGE_ACCESS_KEY",
        "-e",
        "HYORI_STORAGE_SECRET_KEY",
        imageId,
      ],
      {
        HYORI_DATABASE_URL: `postgres://hyori_app:${appPassword}@${postgres}:5432/hyori_bench`,
        HYORI_STORAGE_ACCESS_KEY: env.RUSTFS_ACCESS_KEY,
        HYORI_STORAGE_SECRET_KEY: env.RUSTFS_SECRET_KEY,
      },
    );
    created.push(server);
    let backendUrl = address(server, "3002/tcp");
    await httpReady(`${backendUrl}/health/ready`);
    sql("CREATE EXTENSION pg_stat_statements;");

    const accountsSql = tokens
      .map(
        (token, index) =>
          `INSERT INTO hyori_users(id,email,name,role,quota_bytes) VALUES ('bench_user_${index}','synthetic${index}@example.test','Synthetic ${index}','user',1000000000000); INSERT INTO hyori_sessions(id,token_digest,user_id,expires_at) VALUES ('bench_session_${index}','${createHash("sha256").update(token).digest("hex")}','bench_user_${index}',now()+interval '1 day');`,
      )
      .join("\n");

    sql(`BEGIN; ${accountsSql}\n${seedItemsSql()} COMMIT;`);

    const cardinalities = sql(
      `SELECT json_build_object('items',(SELECT count(*) FROM hyori_items),'accounts',(SELECT count(*) FROM hyori_users),'images',(SELECT count(*) FROM hyori_items WHERE mime_type='image/jpeg'),'incomingGrants',(SELECT count(*) FROM hyori_shares WHERE recipient_id='bench_user_9'),'owners',(SELECT json_agg(row_to_json(s)) FROM (SELECT owner_id,count(*) FROM hyori_items GROUP BY owner_id ORDER BY owner_id) s),'roots',(SELECT json_agg(row_to_json(s)) FROM (SELECT owner_id,count(*) FROM hyori_items WHERE parent_id IS NULL GROUP BY owner_id ORDER BY owner_id) s),'folders',(SELECT json_agg(row_to_json(s)) FROM (SELECT parent_id,count(*) FROM hyori_items WHERE parent_id IS NOT NULL GROUP BY parent_id ORDER BY parent_id) s));`,
    );

    const counts = z
      .object({
        items: z.literal(100000),
        accounts: z.literal(10),
        images: z.literal(20000),
        incomingGrants: z.literal(1201),
      })
      .parse(JSON.parse(cardinalities));

    await writeFile(join(output, "workload.json"), cardinalities);
    await writeFile(join(output, "seed-items.sql"), seedItemsSql());
    await writeFile(
      join(output, "postgres-settings.txt"),
      sql(
        "SELECT version(); SELECT name||'='||setting||' '||coalesce(unit,'') FROM pg_settings WHERE name IN ('shared_buffers','effective_cache_size','work_mem','max_connections','jit','plan_cache_mode','track_io_timing','pg_stat_statements.track','pg_stat_statements.track_planning','log_statement','log_parameter_max_length') ORDER BY name; SELECT pg_database_size(current_database()); SELECT relname,pg_total_relation_size(relid) FROM pg_catalog.pg_statio_user_tables ORDER BY relname;",
      ),
    );

    const limits = created.map((name) => ({
      name,
      configuration: docker([
        "inspect",
        "--format",
        "{{json .HostConfig.CpusetCpus}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}} {{.HostConfig.MemorySwap}} {{.HostConfig.ReadonlyRootfs}}",
        name,
      ]),
    }));

    await writeFile(join(output, "container-limits.json"), JSON.stringify(limits, null, 2));
    assert.equal(counts.items, conditions.items);
    docker(["restart", postgres]);
    await postgresReady();
    docker(["restart", server]);
    backendUrl = address(server, "3002/tcp");
    await httpReady(`${backendUrl}/health/ready`);
    let proxy = createBackendProxy({ origin, backendUrl });

    const consumers = Array.from({ length: conditions.concurrency }, () =>
      tokens.map((token, actor) => {
        const client = createClient({
          baseUrl: `${origin}/api/rpc`,
          cacheScope: `synthetic-${actor}`,
          fetch: async (input, init) => {
            const headers = new Headers(init?.headers);
            headers.set("Origin", origin);
            headers.set("Cookie", `hyori_session=${token}`);

            return proxy(new Request(input, { ...init, headers }));
          },
        });

        clients.push(client);

        return client;
      }),
    );

    const pageDigests = new Map<string, string>();
    const pageIds = new Map<string, string[]>();

    const summaries: {
      phase: TimingRow["phase"];
      journey: string;
      summary: ReturnType<typeof summarize>;
      queryCalls: number;
      queryExecutionMs: number;
      queryPlanningMs: number;
      phaseWallMs: number;
    }[] = [];

    async function request(
      journey: Journey,
      phase: TimingRow["phase"],
      sample: number,
      worker: number,
    ): Promise<TimingRow> {
      const startedAt = new Date().toISOString();
      const start = performance.now();

      try {
        const page = await consumers[worker]![journey.actor]!.rpc.files.list(journey.input, {
          signal: AbortSignal.timeout(conditions.requestTimeoutMs),
        });

        const elapsedMs = performance.now() - start;
        const idDigest = assertPage(page, journey);
        const previous = pageDigests.get(journey.name);

        if (previous)
          assert.equal(idDigest, previous, "unstable page under an unchanged synthetic workload");
        else pageDigests.set(journey.name, idDigest);
        pageIds.set(
          journey.name,
          page.items.map((item) => item.id),
        );

        return {
          phase,
          journey: journey.name,
          sample,
          worker,
          startedAt,
          elapsedMs,
          ok: true,
          rows: page.items.length,
          idDigest,
          errorCode: null,
        };
      } catch (error) {
        return {
          phase,
          journey: journey.name,
          sample,
          worker,
          startedAt,
          elapsedMs: performance.now() - start,
          ok: false,
          rows: null,
          idDigest: null,
          errorCode: normalizeClientError(error).code,
        };
      }
    }

    async function measure(
      journey: Journey,
      phase: TimingRow["phase"],
      sampleCount: number,
      concurrency: number,
    ) {
      sql("SELECT pg_stat_statements_reset();");
      const rows: TimingRow[] = [];
      const start = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async (_, worker) => {
          for (let sample = worker; sample < sampleCount; sample += concurrency)
            rows.push(await request(journey, phase, sample, worker));
        }),
      );
      const phaseWallMs = performance.now() - start;
      const stats = queryStats();
      await appendFile(
        join(output, "timings.ndjson"),
        rows
          .sort((a, b) => a.sample - b.sample)
          .map((row) => `${JSON.stringify(row)}\n`)
          .join(""),
      );
      await writeFile(
        join(output, `${phase}-${journey.name}-queries.json`),
        JSON.stringify(stats, null, 2),
      );

      const budget =
        journey.input.search || journey.input.type
          ? conditions.candidateSearchP95Ms
          : conditions.candidateListingP95Ms;

      const summary = summarize(rows, budget);
      summaries.push({
        phase,
        journey: journey.name,
        summary,
        queryCalls: stats.reduce((sum, row) => sum + row.calls, 0),
        queryExecutionMs: stats.reduce((sum, row) => sum + row.total_exec_time, 0),
        queryPlanningMs: stats.reduce((sum, row) => sum + row.total_plan_time, 0),
        phaseWallMs,
      });
      await writeFile(join(output, "summary.json"), JSON.stringify(summaries, null, 2));
      console.log(
        `${phase} ${journey.name}: n=${summary.samples} errors=${summary.failures} p50=${summary.p50Ms.toFixed(2)} p95=${summary.p95Ms.toFixed(2)}ms`,
      );
    }

    await resources("before-first-pass");

    for (const journey of journeys) await measure(journey, "restart-first-pass", 1, 1);

    for (const journey of journeys) {
      for (let warmup = 0; warmup < conditions.warmupPerJourney; warmup++) {
        const row = await request(journey, "warm-sequential", warmup, 0);
        await appendFile(join(output, "warmups.ndjson"), `${JSON.stringify(row)}\n`);
      }

      await measure(journey, "warm-sequential", conditions.samplesPerJourney, 1);
    }

    await resources("after-sequential");

    for (const journey of journeys)
      await measure(
        journey,
        "warm-concurrent",
        conditions.samplesPerJourney,
        conditions.concurrency,
      );
    await resources("after-concurrent");

    // Capture SQL actually executed by the release image, only AFTER timing. Parameter logging
    // stays disabled: session credentials are never retained in artifacts or raw database logs.
    sql(
      "ALTER ROLE hyori_app SET log_statement='all'; ALTER ROLE hyori_app SET log_parameter_max_length=0;",
    );
    docker(["restart", server]);
    backendUrl = address(server, "3002/tcp");
    await httpReady(`${backendUrl}/health/ready`);
    proxy = createBackendProxy({ origin, backendUrl });
    const since = new Date().toISOString();
    await consumers[0]![0]!.rpc.files.list({ parentId: itemId(3), limit: 100 });

    const logged = spawnSync("docker", ["logs", "--since", since, postgres], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });

    assert.equal(logged.status, 0);
    const text = `${logged.stdout}\n${logged.stderr}`;

    const listSql = text.match(
      /SELECT i\.\* FROM hyori_items i[\s\S]*?ORDER BY i\.id LIMIT \$13/,
    )?.[0];

    const roleSql = text.match(
      /SELECT scope\.id, max\(CASE s\.role[\s\S]*?GROUP BY scope\.id/,
    )?.[0];

    assert.ok(
      listSql && roleSql,
      "release-image query text must be captured, not copied from source",
    );
    await writeFile(join(output, "plans", "executed-list.sql"), listSql);
    await writeFile(join(output, "plans", "executed-roles.sql"), roleSql);
    sql("ALTER ROLE hyori_app RESET log_statement;");
    const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

    for (const journey of journeys) {
      const input: ListInput = journey.input;

      const parameters = [
        quote(`bench_user_${journey.actor}`),
        "'[]'::jsonb",
        quote(input.cursor ?? ""),
        "false",
        String(input.view === "shared"),
        input.parentId ? quote(input.parentId) : "NULL",
        quote(input.search ?? ""),
        quote(input.type ?? ""),
        input.after ? quote(input.after) : "NULL",
        input.before ? quote(input.before) : "NULL",
        input.minSize ?? "NULL",
        input.maxSize ?? "NULL",
        101,
      ].join(",");

      for (const mode of ["force_custom_plan", "force_generic_plan"]) {
        const plan = sql(
          `BEGIN; SET LOCAL ROLE hyori_app; SET LOCAL plan_cache_mode=${mode}; SET LOCAL statement_timeout='35s'; PREPARE bench_list(text,jsonb,text,boolean,boolean,text,text,text,timestamptz,timestamptz,bigint,bigint,bigint) AS ${listSql}; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE bench_list(${parameters}); ROLLBACK;`,
        );

        await writeFile(join(output, "plans", `${journey.name}-${mode}.json`), plan);
      }

      const ids = pageIds.get(journey.name) ?? [];

      if (ids.length) {
        const scopes = sql(
          `SELECT json_agg(json_build_object('id',id,'roots',ancestor_ids||jsonb_build_array(id))) FROM hyori_items WHERE id IN (${ids.map(quote).join(",")});`,
        );

        const plan = sql(
          `BEGIN; SET LOCAL ROLE hyori_app; PREPARE bench_roles(text,jsonb,jsonb) AS ${roleSql}; EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) EXECUTE bench_roles(${quote(`bench_user_${journey.actor}`)},'[]',${quote(scopes)}); ROLLBACK;`,
        );

        await writeFile(join(output, "plans", `${journey.name}-roles-100-returned.json`), plan);
      }
    }

    const clientSourcesAfter = await consumerSourceSnapshot();
    await writeFile(
      join(output, "client-source-after.json"),
      JSON.stringify(clientSourcesAfter, null, 2),
    );

    await writeFile(
      join(output, "completion.json"),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          clientSourcesStable: clientSourcesAfter.digest === clientSources.digest,
          clientSourceDigest: clientSources.digest,
          measuredRequests: summaries.reduce((sum, row) => sum + row.summary.samples, 0),
          failures: summaries.reduce((sum, row) => sum + row.summary.failures, 0),
          notes:
            "EXPLAIN forces custom/generic alternatives; it does not identify which auto plan each pooled server connection used. Role plans use the 100 returned rows, excluding the possible 101st lookahead row. Startup/restarts, seeding/ANALYZE, warmups, stats collection, EXPLAIN and cleanup are outside measured request latency.",
        },
        null,
        2,
      ),
    );
    console.log(`Completed; retain synthetic results at ${output}`);
  } finally {
    for (const client of clients) client.dispose();

    for (const name of created.reverse()) docker(["rm", "--force", "--volumes", name]);

    if (networkCreated) docker(["network", "rm", network]);
  }
}

if (import.meta.main) await main();
