import assert from "node:assert/strict";
import { SQL } from "bun";
import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFile, mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir, loadavg, cpus, totalmem, release } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { journeys, seedItemsSql, itemId } from "./benchmark-rust-metadata.ts";

const inputSchema = z.object({
  actor: z.string().nullable(),
  publicShares: z.array(z.string()).default([]),
  cursor: z.string().default(""),
  view: z.enum(["files", "shared", "trash"]).default("files"),
  parent: z.string().nullable().default(null),
  search: z.string().default(""),
  type: z.string().default(""),
  after: z.string().nullable().default(null),
  before: z.string().nullable().default(null),
  minSize: z.number().nullable().default(null),
  maxSize: z.number().nullable().default(null),
  limit: z.number().int().min(1).max(100).default(100),
});

export type ExperimentInput = z.infer<typeof inputSchema>;

export type Variant =
  | "baseline"
  | "scoped"
  | "share-union"
  | "scope-materialized"
  | "set-scope"
  | "pruned-set"
  | "recommended";

const variants: Variant[] = ["baseline", "scoped", "recommended"];
const modes = ["force_custom_plan", "force_generic_plan"] as const;

const parameterTypes =
  "text,jsonb,text,boolean,boolean,text,text,text,timestamptz,timestamptz,bigint,bigint,bigint";

const image = "postgres:17";
const expectedImage = "sha256:327daa8fae7178d61f93142f146b098467b345e10997b9eb79f63bd58e5c8f3c";

const baselineArchive =
  "/home/aarsh/.t3/userdata/attachments/hyori-metadata-release-20261105-all-three-runs.tar.gz";

const baselineArchiveHash = "56660298407edf2c5394645945be3e581d42343f99b6c220249728ca78f65f70";
const listSourcePath = "apps/server/src/features/files/service.rs";
const policySourcePath = "apps/server/src/features/files/policy.rs";

export function normalizeSql(sql: string) {
  return sql.replace(/\s+/g, " ").trim();
}

/** Extract the retained baseline, not the newly adopted production branch selector. */
export function extractListing(source: string) {
  const query = source.match(
    /"(SELECT i\.\* FROM hyori_items i[\s\S]*?ORDER BY i\.id LIMIT \$13)"/,
  )?.[1];

  assert.ok(query, "authoritative listing SQL not found; do not silently substitute another query");

  return query;
}

export function parameters(input: ExperimentInput) {
  return [
    input.actor,
    JSON.stringify(input.publicShares),
    input.cursor,
    input.view === "trash",
    input.view === "shared",
    input.parent,
    input.search.toLowerCase(),
    input.type,
    input.after,
    input.before,
    input.minSize,
    input.maxSize,
    input.limit + 1,
  ];
}

function filters(input: ExperimentInput) {
  const conditions = ["i.id>$3"];

  if (input.view === "trash") conditions.push("i.trashed_at IS NOT NULL", "i.trash_root=i.id");
  else conditions.push("i.trashed_at IS NULL");

  if (input.search) conditions.push("strpos(lower(i.name),$7)>0");

  if (input.type)
    conditions.push("(i.kind=$8 OR i.mime_type=$8 OR starts_with(i.mime_type,$8||'/'))");

  if (input.after !== null) conditions.push("i.updated_at >= $9");

  if (input.before !== null) conditions.push("i.updated_at <= $10");

  if (input.minSize !== null) conditions.push("i.size >= $11");

  if (input.maxSize !== null) conditions.push("i.size <= $12");

  return conditions;
}

function spatial(input: ExperimentInput) {
  if (input.view === "trash") return [];

  if (input.parent !== null) return ["i.parent_id=$6"];

  if (input.search) return [];

  if (input.view === "shared") return [];

  return ["i.parent_id IS NULL"];
}

function eligibleShares() {
  return `eligible AS MATERIALIZED (
    SELECT DISTINCT s.item_id FROM hyori_shares s
    JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
    WHERE s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
      AND (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb))))
  )`;
}

/** Experiment-only SQL selection. User values remain parameters; only fixed predicates are composed. */
export function candidateSql(baseline: string, input: ExperimentInput, variant: Variant) {
  if (variant === "baseline") return baseline;

  if (variant === "recommended") {
    if (input.view === "trash" || input.parent !== null)
      return candidateSql(baseline, input, "scoped");

    if (input.view === "shared" && input.search === "")
      return candidateSql(baseline, input, "set-scope");

    return baseline;
  }

  const predicates = [...filters(input), ...spatial(input)];
  const activeOwner = "JOIN hyori_users u ON u.id=i.owner_id AND u.status='active'";

  if (input.view === "trash")
    return `SELECT i.* FROM hyori_items i ${activeOwner}
    WHERE i.owner_id=$1 AND ${predicates.join(" AND ")} ORDER BY i.id LIMIT $13`;
  const directSharedRoots = input.view === "shared" && input.parent === null && input.search === "";

  if (variant === "scoped") {
    const authorization = baseline.match(
      /WHERE (\(i\.owner_id=\$1 OR EXISTS \([\s\S]*?\)\))\s+AND i\.id>\$3/,
    )?.[1];

    assert.ok(authorization);
    predicates.push(authorization);

    if (input.view === "shared") predicates.push("i.owner_id IS DISTINCT FROM $1");

    if (directSharedRoots)
      predicates.push(`EXISTS (SELECT 1 FROM hyori_shares s JOIN hyori_users issuer ON issuer.id=s.issuer_id AND issuer.status='active'
      WHERE s.item_id=i.id AND s.revoked_at IS NULL AND (s.expires_at IS NULL OR s.expires_at>now())
        AND (s.recipient_id=$1 OR (s.public AND s.id IN (SELECT jsonb_array_elements_text($2::jsonb)))))`);

    return `SELECT i.* FROM hyori_items i ${activeOwner} WHERE ${predicates.join(" AND ")} ORDER BY i.id LIMIT $13`;
  }

  if (variant === "set-scope" || variant === "pruned-set") {
    // One indexed set lookup for ancestor membership avoids a separate scan per eligible grant.
    // The application's ancestor_ids contract is a JSON array of strings, matching ?| semantics.
    const ancestorRoots = variant === "pruned-set" ? "descendant_roots" : "eligible";

    // Drop only roots whose descendant set is actually empty; never truncate eligible grants
    // or assume that a file/folder label is a substitute for the stored ancestry relation.
    const rootPruning =
      variant === "pruned-set" && !directSharedRoots
        ? `, descendant_roots AS MATERIALIZED (
      SELECT e.item_id FROM eligible e WHERE EXISTS (
        WITH child_scope AS MATERIALIZED (
          SELECT child.id FROM hyori_items child
          WHERE child.ancestor_ids @> jsonb_build_array(e.item_id)
        ) SELECT 1 FROM child_scope
      )
    )`
        : "";

    const scopePredicates = predicates.filter((predicate) => predicate !== "i.id>$3");
    const scopeFilters = scopePredicates.join(" AND ");
    const branches: string[] = [];

    const boundedIds = (scope: string) => `WITH scope_ids AS MATERIALIZED (${scope})
      SELECT id FROM scope_ids WHERE id>$3 ORDER BY id LIMIT $13`;

    if (input.view !== "shared")
      branches.push(
        `(${boundedIds(`SELECT i.id FROM hyori_items i ${activeOwner} WHERE i.owner_id=$1 AND ${scopeFilters}`)})`,
      );
    branches.push(
      `(${boundedIds(`SELECT i.id FROM hyori_items i ${activeOwner}
      WHERE i.id=ANY(ARRAY(SELECT item_id FROM eligible)) AND i.owner_id IS DISTINCT FROM $1 AND ${scopeFilters}`)})`,
    );

    if (!directSharedRoots)
      branches.push(
        `(${boundedIds(`SELECT i.id FROM hyori_items i ${activeOwner}
      WHERE i.ancestor_ids ?| ARRAY(SELECT item_id FROM ${ancestorRoots}) AND i.owner_id IS DISTINCT FROM $1 AND ${scopeFilters}`)})`,
      );

    return `WITH ${eligibleShares()}${rootPruning}, visible AS MATERIALIZED (
      SELECT id FROM (${branches.join(" UNION ")}) combined_ids ORDER BY id LIMIT $13
    ) SELECT i.* FROM visible v JOIN hyori_items i ON i.id=v.id ORDER BY i.id`;
  }

  const foreign = [...predicates, "i.owner_id IS DISTINCT FROM $1"].join(" AND ");

  const ownerScope = `SELECT i.* FROM hyori_items i ${activeOwner}
    WHERE i.owner_id=$1 AND ${predicates.join(" AND ")}`;

  const owned =
    variant === "scope-materialized"
      ? `WITH owner_scope AS MATERIALIZED (${ownerScope}) SELECT * FROM owner_scope ORDER BY id LIMIT $13`
      : `${ownerScope} ORDER BY i.id LIMIT $13`;

  // OFFSET 0 retains a per-root primary-key lookup rather than flattening this into a library scan.
  const direct = `SELECT i.* FROM eligible e CROSS JOIN LATERAL (
    SELECT i.* FROM hyori_items i ${activeOwner}
    WHERE i.id=e.item_id AND ${foreign} OFFSET 0
  ) i ORDER BY i.id LIMIT $13`;

  // Every root can contribute its first limit+1 unique matches. Dedupe precedes the final limit:
  // any omitted row already has limit+1 distinct earlier rows in its own source subset.
  const descendantScope = `SELECT i.* FROM hyori_items i ${activeOwner}
    WHERE i.ancestor_ids @> jsonb_build_array(e.item_id) AND ${foreign}`;

  const descendants =
    variant === "scope-materialized"
      ? `SELECT i.* FROM eligible e CROSS JOIN LATERAL (
        WITH descendant_scope AS MATERIALIZED (${descendantScope})
        SELECT * FROM descendant_scope ORDER BY id LIMIT $13
      ) i`
      : `SELECT i.* FROM eligible e CROSS JOIN LATERAL (
        ${descendantScope} ORDER BY i.id LIMIT $13
      ) i`;

  const branches = [];

  if (input.view !== "shared") branches.push(`(${owned})`);
  branches.push(`(${direct})`);

  if (!directSharedRoots) branches.push(`(${descendants})`);

  return `WITH ${eligibleShares()}
    SELECT * FROM (${branches.join(" UNION ")}) visible ORDER BY id LIMIT $13`;
}

const itemSchema = z.object({
  id: z.string(),
  owner_id: z.string(),
  parent_id: z.string().nullable(),
  name: z.string(),
  kind: z.enum(["file", "folder"]),
  size: z.number(),
  mime_type: z.string(),
  ancestor_ids: z.array(z.string()),
  trashed_at: z.string().nullable(),
  trash_root: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  object_key: z.string().nullable(),
  uploaded_by: z.string().nullable(),
  revision: z.number(),
});

const itemsSchema = z.array(itemSchema);
const rolesSchema = z.array(z.object({ id: z.string(), rank: z.number().int().min(1).max(3) }));

type Item = z.infer<typeof itemSchema>;

function capabilities(item: Item, actor: string | null, roles: z.infer<typeof rolesSchema>) {
  const owner = actor === item.owner_id;
  const rank = item.trashed_at ? null : (roles.find((role) => role.id === item.id)?.rank ?? null);

  return {
    isOwner: owner,
    roleRank: rank,
    canDownload: owner || rank !== null,
    canUpload: !item.trashed_at && item.kind === "folder" && (owner || (rank ?? 0) >= 2),
    canEdit: !item.trashed_at && (owner || rank === 3),
    canDelete: owner,
    canShare: owner && !item.trashed_at,
  };
}

const fixtureHelpers = `
CREATE FUNCTION bench_arguments(values_json jsonb) RETURNS text LANGUAGE sql IMMUTABLE AS $$
 SELECT string_agg(CASE WHEN value='null'::jsonb THEN 'NULL' ELSE format('%L',value #>> '{}') END,',' ORDER BY ord)
 FROM jsonb_array_elements(values_json) WITH ORDINALITY AS args(value,ord)
$$;
CREATE FUNCTION bench_result(statement_name text, values_json jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb := '[]'; r record;
BEGIN
 FOR r IN EXECUTE format('EXECUTE %I(%s)',statement_name,bench_arguments(values_json)) LOOP
   result := result || jsonb_build_array(to_jsonb(r));
 END LOOP;
 RETURN result;
END $$;
CREATE FUNCTION bench_estimate(statement_name text, values_json jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 EXECUTE format('EXPLAIN (FORMAT JSON) EXECUTE %I(%s)',statement_name,bench_arguments(values_json)) INTO result;
 RETURN result;
END $$;
CREATE FUNCTION bench_plan(statement_name text, values_json jsonb) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE result jsonb;
BEGIN
 EXECUTE format('EXPLAIN (ANALYZE,BUFFERS,TIMING OFF,FORMAT JSON) EXECUTE %I(%s)',statement_name,bench_arguments(values_json)) INTO result;
 RETURN result;
END $$;
`;

// PostgreSQL-format JSON is validated at the driver boundary; nested plans retain their owned shape.
const nodeSchema = z.object({
  "Node Type": z.string(),
  "Relation Name": z.string().optional(),
  "Index Name": z.string().optional(),
  "Subplan Name": z.string().optional(),
  "Actual Rows": z.number(),
  "Actual Loops": z.number(),
  "Rows Removed by Filter": z.number().optional(),
  "Rows Removed by Index Recheck": z.number().optional(),
  "Shared Hit Blocks": z.number().optional(),
  "Shared Read Blocks": z.number().optional(),
  "Plan Rows": z.number().optional(),
  get Plans() {
    return z.array(nodeSchema).optional();
  },
});

const planSchema = z
  .array(z.object({ Plan: nodeSchema, "Planning Time": z.number(), "Execution Time": z.number() }))
  .length(1);

type PlanNode = z.infer<typeof nodeSchema>;

export function planCounters(root: PlanNode) {
  const scans: {
    node: string;
    relation: string;
    index: string | null;
    rows: number;
    loops: number;
    examined: number;
  }[] = [];

  const subplans: { name: string; loops: number }[] = [];

  function visit(node: PlanNode) {
    if (node["Relation Name"])
      scans.push({
        node: node["Node Type"],
        relation: node["Relation Name"],
        index: node["Index Name"] ?? null,
        rows: node["Actual Rows"],
        loops: node["Actual Loops"],
        examined:
          (node["Actual Rows"] +
            (node["Rows Removed by Filter"] ?? 0) +
            (node["Rows Removed by Index Recheck"] ?? 0)) *
          node["Actual Loops"],
      });

    if (node["Subplan Name"])
      subplans.push({ name: node["Subplan Name"], loops: node["Actual Loops"] });

    for (const child of node.Plans ?? []) visit(child);
  }

  visit(root);

  return {
    scans,
    subplans,
    sharedHits: root["Shared Hit Blocks"] ?? 0,
    sharedReads: root["Shared Read Blocks"] ?? 0,
    caveat:
      "Rows/filters are per-loop rounded PostgreSQL counters; summed examined counts are approximate work, not distinct rows. Bitmap/index/heap levels must not be summed as unique rows.",
  };
}

type Case = {
  name: string;
  input: ExperimentInput;
  includes?: string[];
  excludes?: string[];
  count?: number;
  expectedRank?: { id: string; rank: number; canEdit: boolean; canDelete: boolean };
  authorityNote?: string;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

async function main() {
  const output = await mkdtemp(join(tmpdir(), "hyori-query-experiments-"));
  await mkdir(join(output, "plans"));
  await mkdir(join(output, "queries"));
  console.log(`Synthetic SQL experiment artifacts: ${output}`);
  const source = await readFile(listSourcePath, "utf8");
  const baseline = extractListing(source);
  const policy = await readFile(policySourcePath, "utf8");

  const roles = policy.match(
    /"(SELECT scope\.id, max\(CASE s\.role[\s\S]*?GROUP BY scope\.id)"/,
  )?.[1];

  const grantResolution = policy.match(/"(SELECT s\.id FROM hyori_grants g[\s\S]*?LIMIT 16)"/)?.[1];
  assert.ok(roles && grantResolution);
  assert.equal(
    createHash("sha256")
      .update(await readFile(baselineArchive))
      .digest("hex"),
    baselineArchiveHash,
  );

  // Read the verified archive member as data; no extraction or executable code is involved.
  const old = execFileSync(
    "tar",
    ["-xOf", baselineArchive, "hyori-metadata-benchmark-uREpG8/plans/executed-list.sql"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 },
  );

  assert.equal(
    normalizeSql(baseline),
    normalizeSql(old),
    "Retained baseline listing SQL differs from the recorded release query; review applicability before benchmarking.",
  );

  const fixed = {
    at: new Date().toISOString(),
    image,
    expectedImage,
    currentSource: listSourcePath,
    currentSourceHash: hash(source),
    currentListingHash: hash(baseline),
    listingSourceMeaning:
      "Retained BASELINE_LIST_SQL only; production now selects bounded parent/trash/shared-root branches. This run executes experimental templates, not Rust's selector or binding code.",
    oldCapturedHash: hash(old),
    normalizedHash: hash(normalizeSql(baseline)),
    normalizedEqual: true,
    rolesHash: hash(roles),
    grantResolutionHash: hash(grantResolution),
    parameterTypes,
    parameterOrder: [
      "actor",
      "validated public share IDs JSON",
      "cursor",
      "trash",
      "shared",
      "parent",
      "lowercase search",
      "type",
      "after",
      "before",
      "min size",
      "max size",
      "limit+1",
    ],
    variants,
    modes,
    repeats: { primaryJourneys: 3, edgeCases: 1 },
    jit: "unchanged/on; never disabled",
    indexes: "existing migrations 0001/0002 only; no new indexes or extensions",
    boundary: "SQL-only fixture result/plan equivalence, NOT SDK/Rust/API/race acceptance",
    host: {
      model: cpus()[0]?.model,
      logicalCpus: cpus().length,
      memory: totalmem(),
      kernel: release(),
      load: loadavg(),
    },
    confounders:
      "Concurrent Deck WASM builds, compiles and other Docker fixtures; no quiet-host or capacity inference",
    harnessHash: hash(await readFile(import.meta.filename, "utf8")),
    baselineArchiveHash,
  };

  await writeFile(join(output, "conditions.json"), JSON.stringify(fixed, null, 2));
  await writeFile(join(output, "queries", "baseline.sql"), baseline);
  await writeFile(join(output, "queries", "roles.sql"), roles);
  await writeFile(join(output, "queries", "grant-resolution.sql"), grantResolution);
  const name = `hyori-query-pg-${randomBytes(8).toString("hex")}`;
  const password = randomBytes(32).toString("hex");
  let started = false;
  let db: SQL | undefined;

  function docker(args: string[]) {
    return execFileSync("docker", args, {
      env: { ...process.env, POSTGRES_PASSWORD: password },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  try {
    assert.equal(docker(["image", "inspect", "--format", "{{.Id}}", image]), expectedImage);
    docker([
      "run",
      "--detach",
      "--name",
      name,
      "-p",
      "127.0.0.1::5432",
      "-e",
      "POSTGRES_PASSWORD",
      "-e",
      "POSTGRES_USER=hyori_experiment",
      "-e",
      "POSTGRES_DB=hyori_experiment",
      expectedImage,
    ]);
    started = true;
    const address = docker(["port", name, "5432/tcp"]);
    assert.match(address, /^127\.0\.0\.1:\d+$/);
    let ready = false;

    for (let attempt = 0; attempt < 300; attempt++) {
      try {
        docker(["exec", name, "pg_isready", "-U", "hyori_experiment"]);
        ready = true;
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    assert.ok(ready);
    db = new SQL(`postgres://hyori_experiment:${password}@${address}/hyori_experiment`, { max: 1 });
    const connection = db;
    const sourceHashes: { path: string; sha256: string }[] = [];

    for (const path of [
      "apps/server/migrations/0001_auth.sql",
      "apps/server/migrations/0002_files_shares.sql",
    ]) {
      const sql = await readFile(path, "utf8");
      sourceHashes.push({ path, sha256: hash(sql) });
      await connection.unsafe(sql).simple();
    }

    await connection.unsafe(fixtureHelpers).simple();

    for (let index = 0; index < 10; index++)
      await connection.unsafe(
        "INSERT INTO hyori_users(id,email,name,role,quota_bytes) VALUES ($1,$2,$3,'user',1000000000000)",
        [`bench_user_${index}`, `synthetic${index}@example.test`, `Synthetic ${index}`],
      );
    await connection.unsafe(seedItemsSql()).simple();
    await connection.unsafe("SET statement_timeout='30s'; SET jit=on;").simple();
    await connection
      .unsafe(
        `PREPARE role_query(text,jsonb,jsonb) AS ${roles}; PREPARE grant_query(jsonb) AS ${grantResolution};`,
      )
      .simple();
    const prepared = new Map<string, string>();

    const equivalence: {
      phase: string;
      case: string;
      mode: string;
      variant: Variant;
      rowsIncludingLookahead: number;
      nextCursor: string | null;
      digest: string;
      equivalent: boolean;
      authorityNote: string | null;
    }[] = [];

    const measurements: {
      case: string;
      variant: Variant;
      mode: string;
      repeat: number;
      planningMs: number;
      executionMs: number;
      counters: ReturnType<typeof planCounters>;
    }[] = [];

    async function statement(query: string) {
      const cached = prepared.get(query);

      if (cached) return cached;
      const name = `experiment_${prepared.size}`;
      await connection.unsafe(`PREPARE ${name}(${parameterTypes}) AS ${query}`).simple();
      prepared.set(query, name);

      return name;
    }

    async function results(statementName: string, values: ReturnType<typeof parameters>) {
      const rows = z
        .array(z.object({ result: itemsSchema }))
        .parse(
          await connection.unsafe("SELECT bench_result($1::text,$2::text::jsonb) AS result", [
            statementName,
            JSON.stringify(values),
          ]),
        );

      return rows[0]!.result;
    }

    async function projection(items: Item[], input: ExperimentInput) {
      const scopes = items.flatMap((item) =>
        item.trashed_at ? [] : [{ id: item.id, roots: [...item.ancestor_ids, item.id] }],
      );

      const rows = z
        .array(z.object({ result: rolesSchema }))
        .parse(
          await connection.unsafe("SELECT bench_result('role_query',$1::text::jsonb) AS result", [
            JSON.stringify([
              input.actor,
              JSON.stringify(input.publicShares),
              JSON.stringify(scopes),
            ]),
          ]),
        );

      return {
        entries: items
          .slice(0, input.limit)
          .map((item) => ({ ...item, access: capabilities(item, input.actor, rows[0]!.result) })),
        nextCursor: items.length > input.limit ? items[input.limit - 1]!.id : null,
      };
    }

    async function runCase(testCase: Case, phase: string, plans: boolean) {
      const values = parameters(testCase.input);
      await writeFile(
        join(output, "queries", `${phase}-${testCase.name}-parameters.json`),
        JSON.stringify(
          { input: testCase.input, values, authorityNote: testCase.authorityNote },
          null,
          2,
        ),
      );

      for (const mode of modes) {
        await connection.unsafe(`SET plan_cache_mode=${mode}`).simple();
        const baselineRows = await results(await statement(baseline), values);
        const expected = await projection(baselineRows, testCase.input);
        const expectedIds = expected.entries.map((item) => item.id);
        assert.equal(new Set(expectedIds).size, expectedIds.length);
        assert.deepEqual(expectedIds, [...expectedIds].sort());

        if (testCase.count !== undefined)
          assert.equal(expected.entries.length, testCase.count, testCase.name);

        for (const id of testCase.includes ?? [])
          assert.ok(expectedIds.includes(id), `${testCase.name} must include ${id}`);

        for (const id of testCase.excludes ?? [])
          assert.ok(!expectedIds.includes(id), `${testCase.name} must exclude ${id}`);

        if (testCase.expectedRank) {
          const entry = expected.entries.find((item) => item.id === testCase.expectedRank!.id);
          assert.ok(entry);
          assert.equal(entry.access.roleRank, testCase.expectedRank.rank);
          assert.equal(entry.access.canEdit, testCase.expectedRank.canEdit);
          assert.equal(entry.access.canDelete, testCase.expectedRank.canDelete);
        }

        for (const variant of variants) {
          const query = candidateSql(baseline, testCase.input, variant);
          await writeFile(
            join(output, "queries", `${phase}-${testCase.name}-${variant}.sql`),
            query,
          );
          const preparedName = await statement(query);
          const actualRows = await results(preparedName, values);
          const actual = await projection(actualRows, testCase.input);
          assert.deepEqual(
            actualRows,
            baselineRows,
            `${phase}/${testCase.name}/${mode}/${variant} raw rows`,
          );
          assert.deepEqual(
            actual,
            expected,
            `${phase}/${testCase.name}/${mode}/${variant} capabilities/cursor`,
          );
          equivalence.push({
            phase,
            case: testCase.name,
            mode,
            variant,
            rowsIncludingLookahead: actualRows.length,
            nextCursor: actual.nextCursor,
            digest: hash(JSON.stringify(actual)),
            equivalent: true,
            authorityNote: testCase.authorityNote ?? null,
          });
          await writeFile(join(output, "equivalence.json"), JSON.stringify(equivalence, null, 2));

          for (let repeat = 0; repeat < (plans ? 3 : 1); repeat++) {
            const response = await connection.unsafe(
              "SELECT bench_plan($1::text,$2::text::jsonb) AS plan",
              [preparedName, JSON.stringify(values)],
            );

            const raw = z.array(z.object({ plan: z.json() })).parse(response)[0]!.plan;
            const plan = planSchema.parse(raw)[0]!;
            await writeFile(
              join(output, "plans", `${testCase.name}-${variant}-${mode}-${repeat}.json`),
              JSON.stringify(raw, null, 2),
            );

            const measured = {
              case: testCase.name,
              variant,
              mode,
              repeat,
              planningMs: plan["Planning Time"],
              executionMs: plan["Execution Time"],
              counters: planCounters(plan.Plan),
            };

            measurements.push(measured);
            await appendFile(join(output, "measurements.ndjson"), `${JSON.stringify(measured)}\n`);
          }
        }
      }

      console.log(`${phase} ${testCase.name}: all 3 variants × both plan modes equivalent`);
    }

    const baseCases: Case[] = journeys.map((journey) => ({
      name: journey.name,
      input: inputSchema.parse({
        actor: `bench_user_${journey.actor}`,
        ...journey.input,
        parent: journey.input.parentId ?? null,
      }),
      count: journey.count,
    }));

    await writeFile(
      join(output, "fixture.json"),
      JSON.stringify(
        {
          phase: "base",
          items: 100000,
          accounts: 10,
          grants: 1201,
          migrations: sourceHashes,
          seedSqlHash: hash(seedItemsSql()),
          limits: docker([
            "inspect",
            "--format",
            "{{json .HostConfig.CpusetCpus}} {{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}",
            name,
          ]),
        },
        null,
        2,
      ),
    );

    for (const testCase of baseCases) await runCase(testCase, "base", true);

    // Retain and reproduce the rejected first attempt, rather than silently discarding its timeout.
    const rejectedInput = inputSchema.parse({
      actor: "bench_user_9",
      view: "shared",
      search: "report",
    });

    const rejectedSql = candidateSql(baseline, rejectedInput, "share-union");
    const rejectedStatement = await statement(rejectedSql);
    await connection.unsafe("SET plan_cache_mode=force_generic_plan").simple();

    const estimate = z
      .array(z.object({ plan: z.json() }))
      .parse(
        await connection.unsafe("SELECT bench_estimate($1::text,$2::text::jsonb) AS plan", [
          rejectedStatement,
          JSON.stringify(parameters(rejectedInput)),
        ]),
      )[0]!.plan;

    await writeFile(join(output, "queries", "rejected-share-union.sql"), rejectedSql);
    await writeFile(
      join(output, "plans", "rejected-share-union-estimate-only.json"),
      JSON.stringify(estimate, null, 2),
    );
    const rejectedStart = performance.now();
    let rejectedOutcome = "completed";

    try {
      await results(rejectedStatement, parameters(rejectedInput));
    } catch (error) {
      assert.equal(z.object({ errno: z.string() }).parse(error).errno, "57014");
      rejectedOutcome = "statement-timeout";
    }

    await writeFile(
      join(output, "rejected-trial.json"),
      JSON.stringify(
        {
          variant: "share-union",
          input: rejectedInput,
          mode: "force_generic_plan",
          statementTimeoutMs: 30000,
          wallMs: performance.now() - rejectedStart,
          outcome: rejectedOutcome,
          planHasActualCounters: false,
        },
        null,
        2,
      ),
    );
    console.log(`Rejected original share-union generic search: ${rejectedOutcome}`);

    await seedEdges(connection);
    const edgeCases = makeEdgeCases();

    for (const testCase of edgeCases) await runCase(testCase, "edges", false);

    async function publicAuthority(digests: string[]) {
      const rows = z
        .array(z.object({ result: z.array(z.object({ id: z.string() })) }))
        .parse(
          await connection.unsafe("SELECT bench_result('grant_query',$1::text::jsonb) AS result", [
            JSON.stringify([JSON.stringify(digests)]),
          ]),
        );

      return rows[0]!.result.map((row) => row.id);
    }

    for (const [name, digest, expectedCount] of [
      ["active", "a", 100],
      ["expired-share", "b", 0],
      ["revoked-share", "c", 0],
      ["expired-grant", "d", 0],
      ["inactive-issuer", "e", 0],
    ] as const) {
      const shares = await publicAuthority([digest.repeat(64)]);
      assert.equal(
        shares.length,
        expectedCount === 100 ? 1 : 0,
        `current grant resolution: ${name}`,
      );
      await runCase(
        {
          name: `public-${name}`,
          input: inputSchema.parse({ actor: null, publicShares: shares, parent: itemId(1) }),
          count: expectedCount,
          authorityNote: shares.length
            ? "Currently resolved public authority; parent policy still required by production."
            : "No resolved authority: production must reject before listing; SQL-only comparison expects no rows, not API success.",
        },
        "public",
        false,
      );
    }

    const current = await publicAuthority(["a".repeat(64)]);
    await runCase(
      {
        name: "mixed-account-public",
        input: inputSchema.parse({
          actor: "bench_user_9",
          publicShares: current,
          parent: itemId(1),
        }),
        count: 100,
      },
      "public",
      false,
    );
    await connection.unsafe(
      "UPDATE hyori_grants SET expires_at=now()-interval '1 second' WHERE token_digest=$1",
      ["a".repeat(64)],
    );
    const expired = await publicAuthority(["a".repeat(64)]);
    assert.deepEqual(expired, []);
    await runCase(
      {
        name: "grant-expired-after-resolution",
        input: inputSchema.parse({
          actor: "bench_user_9",
          publicShares: expired,
          parent: itemId(1),
        }),
        count: 0,
        authorityNote:
          "Production parent reauthorization rejects this request; no old resolved IDs are reused.",
      },
      "public",
      false,
    );

    await connection.unsafe("UPDATE hyori_shares SET revoked_at=now() WHERE id=$1", [
      "edge_overlap",
    ]);
    await runCase(
      {
        name: "direct-revoked-inherited-remains",
        input: inputSchema.parse({ actor: "bench_user_9", parent: itemId(3) }),
        expectedRank: { id: itemId(1201), rank: 2, canEdit: false, canDelete: false },
      },
      "transitions",
      false,
    );
    await connection.unsafe("UPDATE hyori_users SET status='deleting' WHERE id=$1", [
      "bench_user_1",
    ]);
    await runCase(
      {
        name: "foreign-owner-disabled",
        input: inputSchema.parse({ actor: "bench_user_0", search: "document-11201" }),
        count: 0,
      },
      "transitions",
      false,
    );
    await connection
      .unsafe("UPDATE hyori_shares SET revoked_at=now() WHERE revoked_at IS NULL")
      .simple();

    for (const testCase of [
      {
        name: "no-shares-private-root",
        input: inputSchema.parse({ actor: "bench_user_3" }),
        count: 100,
      },
      {
        name: "no-shares-empty-account",
        input: inputSchema.parse({ actor: "bench_empty" }),
        count: 0,
      },
      {
        name: "no-shares-global-negative",
        input: inputSchema.parse({ actor: "bench_user_9", search: "private-owner5-secret" }),
        count: 0,
      },
      {
        name: "no-shares-shared-roots",
        input: inputSchema.parse({ actor: "bench_user_9", view: "shared" }),
        count: 0,
      },
    ])
      await runCase(testCase, "no-sharing", false);

    await writeFile(
      join(output, "completion.json"),
      JSON.stringify(
        {
          completedAt: new Date().toISOString(),
          comparisons: equivalence.length,
          cases: equivalence.length / 6,
          plans: measurements.length,
          equivalencePassed: true,
          finalHostLoad: loadavg(),
          listSourceStillMatches: hash(await readFile(listSourcePath, "utf8")) === hash(source),
          listingSqlStillMatches:
            normalizeSql(extractListing(await readFile(listSourcePath, "utf8"))) ===
            normalizeSql(baseline),
          notes:
            "Only fixture SQL exercised. Identity, parent authorization, transaction/revocation races, SDK/web and released server integration remain mandatory follow-up.",
        },
        null,
        2,
      ),
    );
    console.log(
      `Completed ${equivalence.length} equivalence comparisons and ${measurements.length} plans: ${output}`,
    );
  } finally {
    await db?.close();

    if (started) docker(["rm", "--force", "--volumes", name]);
  }
}

async function seedEdges(db: SQL) {
  for (const user of ["bench_empty", "bench_disabled"])
    await db.unsafe(
      "INSERT INTO hyori_users(id,email,name,role,quota_bytes,status) VALUES ($1,$2,$1,'user',1000000000000,$3)",
      [user, `${user}@example.test`, user === "bench_disabled" ? "deleting" : "active"],
    );
  await db
    .unsafe(`INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids,trashed_at,trash_root)
VALUES ('edge_nested','bench_user_0','item_000003','nested','folder',0,'inode/directory','["item_000003"]',NULL,NULL),
 ('edge_trash_folder','bench_user_0',NULL,'trashed-folder','folder',0,'inode/directory','[]',now(),'edge_trash_folder'),
 ('edge_trash_child','bench_user_0','edge_trash_folder','trashed-child','file',7,'text/plain','["edge_trash_folder"]',now(),'edge_trash_folder'),
 ('edge_trash_file','bench_user_0',NULL,'trashed-file','file',7,'text/plain','[]',now(),'edge_trash_file'),
 ('edge_disabled','bench_disabled',NULL,'disabled','folder',0,'inode/directory','[]',NULL,NULL);
INSERT INTO hyori_items(id,owner_id,parent_id,name,kind,size,mime_type,ancestor_ids)
SELECT 'nested_'||lpad(g::text,3,'0'),'bench_user_0','edge_nested','nested-report-'||g,'file',g,'text/plain','["item_000003","edge_nested"]' FROM generate_series(1,120) g;
INSERT INTO hyori_shares(id,item_id,issuer_id,recipient_id,public,role) VALUES
 ('edge_overlap','item_001201','bench_user_0','bench_user_9',false,'editor'),
 ('edge_nested_share','edge_nested','bench_user_0','bench_user_9',false,'editor'),
 ('edge_root_foreign','item_011201','bench_user_1','bench_user_0',false,'viewer'),
 ('edge_trash_share','edge_trash_folder','bench_user_0','bench_user_9',false,'editor');`)
    .simple();

  const publicRows = [
    {
      id: "edge_public_active",
      item: itemId(1),
      issuer: "bench_user_0",
      token: "a",
      expiry: "2100-01-01T00:00:00Z",
      revoked: false,
      grantExpired: false,
    },
    {
      id: "edge_public_expired",
      item: itemId(1),
      issuer: "bench_user_0",
      token: "b",
      expiry: "2000-01-01T00:00:00Z",
      revoked: false,
      grantExpired: false,
    },
    {
      id: "edge_public_revoked",
      item: itemId(1),
      issuer: "bench_user_0",
      token: "c",
      expiry: null,
      revoked: true,
      grantExpired: false,
    },
    {
      id: "edge_public_grant_expired",
      item: itemId(1),
      issuer: "bench_user_0",
      token: "d",
      expiry: null,
      revoked: false,
      grantExpired: true,
    },
    {
      id: "edge_public_disabled",
      item: "edge_disabled",
      issuer: "bench_disabled",
      token: "e",
      expiry: null,
      revoked: false,
      grantExpired: false,
    },
  ];

  for (const row of publicRows) {
    await db.unsafe(
      "INSERT INTO hyori_shares(id,item_id,issuer_id,public,role,token_digest,expires_at,revoked_at) VALUES ($1,$2,$3,true,'viewer',$4,$5,CASE WHEN $6::boolean THEN now() ELSE NULL END)",
      [row.id, row.item, row.issuer, row.token.repeat(64), row.expiry, row.revoked],
    );
    await db.unsafe(
      "INSERT INTO hyori_grants(token_digest,share_id,created_at,expires_at) VALUES ($1,$2,now()-interval '2 hours',CASE WHEN $3::boolean THEN now()-interval '1 hour' ELSE now()+interval '1 hour' END)",
      [row.token.repeat(64), row.id, row.grantExpired],
    );
  }

  await db
    .unsafe("ANALYZE hyori_items; ANALYZE hyori_users; ANALYZE hyori_shares; ANALYZE hyori_grants;")
    .simple();
}

function makeEdgeCases(): Case[] {
  const owned = { actor: "bench_user_0" };
  const shared = { actor: "bench_user_9" };

  return [
    {
      name: "foreign-accessible-root",
      input: inputSchema.parse({ ...owned, cursor: itemId(100) }),
      includes: [itemId(11201)],
      excludes: [itemId(11202)],
      count: 1,
    },
    {
      name: "overlap-strongest-role",
      input: inputSchema.parse({ ...shared, parent: itemId(3) }),
      expectedRank: { id: itemId(1201), rank: 3, canEdit: true, canDelete: false },
    },
    {
      name: "overlap-nested-page",
      input: inputSchema.parse({ ...shared, parent: "edge_nested" }),
      count: 100,
      expectedRank: { id: "nested_001", rank: 3, canEdit: true, canDelete: false },
    },
    {
      name: "overlap-nested-page2",
      input: inputSchema.parse({ ...shared, parent: "edge_nested", cursor: "nested_100" }),
      count: 20,
    },
    {
      name: "shared-parent-search",
      input: inputSchema.parse({
        ...shared,
        view: "shared",
        parent: itemId(3),
        search: "report",
        type: "image",
      }),
      count: 100,
    },
    {
      name: "shared-roots-type-only",
      input: inputSchema.parse({ ...shared, view: "shared", type: "folder" }),
      includes: ["edge_nested", itemId(3)],
      excludes: ["edge_trash_folder"],
      count: 2,
    },
    {
      name: "owner-shared-filter-excludes-self",
      input: inputSchema.parse({ ...owned, view: "shared", parent: itemId(3) }),
      count: 0,
    },
    {
      name: "owner-global-search-nested",
      input: inputSchema.parse({ ...owned, search: "nested-report", minSize: 10, maxSize: 50 }),
      count: 41,
    },
    {
      name: "private-account-root",
      input: inputSchema.parse({ actor: "bench_user_3" }),
      count: 100,
    },
    {
      name: "private-account-denied-search",
      input: inputSchema.parse({ actor: "bench_user_3", search: "private-owner5-secret" }),
      count: 0,
    },
    { name: "empty-private-account", input: inputSchema.parse({ actor: "bench_empty" }), count: 0 },
    {
      name: "zero-size-folder-filter",
      input: inputSchema.parse({ ...owned, type: "folder", maxSize: 0 }),
      count: 3,
    },
    {
      name: "trash-owned-groups",
      input: inputSchema.parse({ ...owned, view: "trash" }),
      includes: ["edge_trash_folder", "edge_trash_file"],
      excludes: ["edge_trash_child"],
      count: 2,
    },
    {
      name: "trash-ignores-parent-in-list-query",
      input: inputSchema.parse({ ...owned, view: "trash", parent: itemId(3) }),
      count: 2,
      authorityNote:
        "Service still authorizes the supplied parent before this SQL; retain that precondition.",
    },
    {
      name: "trash-filter-cursor",
      input: inputSchema.parse({
        ...owned,
        view: "trash",
        search: "trashed",
        type: "file",
        cursor: "edge_trash_child",
        minSize: 7,
        maxSize: 7,
      }),
      includes: ["edge_trash_file"],
      count: 1,
    },
    {
      name: "foreign-trash-never-visible",
      input: inputSchema.parse({ ...shared, view: "trash" }),
      count: 0,
    },
    {
      name: "shared-search-excludes-trash",
      input: inputSchema.parse({ ...shared, view: "shared", search: "trashed" }),
      count: 0,
    },
    {
      name: "typed-search-cursor",
      input: inputSchema.parse({
        ...owned,
        search: "REPORT",
        cursor: itemId(1000),
        type: "application/pdf",
        after: "2026-01-01T00:00:00Z",
        before: "2026-12-31T23:59:59Z",
      }),
      count: 100,
    },
    {
      name: "literal-sql-like-search",
      input: inputSchema.parse({ ...shared, search: "' OR true;--" }),
      count: 0,
    },
    {
      name: "last-grant-not-truncated",
      input: inputSchema.parse({ ...shared, view: "shared", cursor: itemId(13399) }),
      includes: [itemId(13400)],
      count: 1,
    },
  ];
}

const productionTemplateSchema = z.array(
  z.object({
    input: inputSchema,
    sql: z.string(),
    parameterSlots: z.array(z.number().int().min(1).max(13)),
  }),
);

type ProductionTemplates = z.infer<typeof productionTemplateSchema>;

/** Checks actual Rust-built SQL after restoring fixture slot numbering; never opens a database. */
export function checkProductionTemplates(baseline: string, templates: ProductionTemplates) {
  assert.ok(templates.length > 0, "no production templates supplied");

  for (const template of templates) {
    const used = new Set<number>();

    const restored = template.sql.replace(/\$(\d+)/g, (_, index: string) => {
      const slot = Number(index);
      used.add(slot);
      const original = template.parameterSlots[slot - 1];
      assert.ok(original, `unbound production slot ${slot}`);

      return `$${original}`;
    });

    assert.equal(used.size, template.parameterSlots.length, "unused production bindings");
    const expected = candidateSql(baseline, template.input, "recommended");
    // These fixed SQL templates have no whitespace-bearing literals; only layout may differ.
    assert.equal(restored.replace(/\s+/g, ""), expected.replace(/\s+/g, ""));
  }

  return templates.length;
}

if (import.meta.main) {
  if (process.argv[2] === "--check-production-templates") {
    const path = process.argv[3];
    assert.ok(path, "pass the JSON exported by the Rust listing unit test");
    const baseline = extractListing(await readFile(listSourcePath, "utf8"));
    const templates = productionTemplateSchema.parse(JSON.parse(await readFile(path, "utf8")));
    const count = checkProductionTemplates(baseline, templates);
    process.stdout.write(
      `Verified ${count} Rust-built templates against the experimental recommendation; no services started.\n`,
    );
  } else {
    assert.equal(process.argv.length, 2, "unknown experiment arguments");
    await main();
  }
}
