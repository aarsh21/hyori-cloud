import { expect, test } from "bun:test";
import {
  candidateSql,
  checkProductionTemplates,
  extractListing,
  normalizeSql,
  parameters,
  planCounters,
  readBaselineSource,
  type ExperimentInput,
} from "./metadata-query-experiments.ts";

function input(patch: Partial<ExperimentInput> = {}): ExperimentInput {
  return {
    actor: "fixture",
    publicShares: [],
    cursor: "",
    view: "files",
    parent: null,
    search: "",
    type: "",
    after: null,
    before: null,
    minSize: null,
    maxSize: null,
    limit: 100,
    ...patch,
  };
}

const baseline = extractListing(readBaselineSource("apps/server/src/features/files/service.rs"));

test("rejects missing authoritative SQL and normalizes whitespace only", () => {
  expect(() => extractListing("not a query")).toThrow();
  expect(normalizeSql("SELECT  i.*\n FROM t")).toBe("SELECT i.* FROM t");
  expect(normalizeSql(baseline)).toContain("CASE");
});

test("only fixed SQL predicates are selected; hostile values remain bound parameters", () => {
  const request = input({ search: "' OR true;--", parent: "folder'", minSize: 0 });
  const query = candidateSql(baseline, request, "scoped");
  expect(query).not.toContain(request.search);
  expect(query).not.toContain(request.parent!);
  expect(query).toContain("i.parent_id=$6");
  expect(query).toContain("i.size >= $11");
  expect(parameters(request)[6]).toBe("' or true;--");
  expect(parameters(request)).toHaveLength(13);
  expect(parameters(request)[12]).toBe(101);
});

test("shared roots stay direct-only when type-filtered but search expands inheritance", () => {
  const roots = candidateSql(baseline, input({ view: "shared", type: "folder" }), "share-union");
  expect(roots).not.toContain("ancestor_ids @>");
  const search = candidateSql(baseline, input({ view: "shared", search: "report" }), "share-union");
  expect(search).toContain("ancestor_ids @>");
  expect(search).toContain("i.owner_id IS DISTINCT FROM $1");
});

test("set scopes acquire ancestor IDs once through the existing JSONB membership operator", () => {
  const query = candidateSql(baseline, input({ search: "missing" }), "set-scope");
  expect(query).toContain("i.ancestor_ids ?| ARRAY(SELECT item_id FROM eligible)");
  expect(query).toContain("scope_ids AS MATERIALIZED");
  expect(query).not.toContain("LATERAL");
  expect(query).toContain("SELECT i.* FROM visible v JOIN hyori_items i ON i.id=v.id");
});

test("ancestor-root pruning is data-backed, keeps all direct grants, and adds no kind assumption", () => {
  const query = candidateSql(baseline, input({ search: "missing" }), "pruned-set");
  expect(query).toContain("child_scope AS MATERIALIZED");
  expect(query).toContain("child.ancestor_ids @> jsonb_build_array(e.item_id)");
  expect(query).toContain("i.id=ANY(ARRAY(SELECT item_id FROM eligible))");
  expect(query).toContain("i.ancestor_ids ?| ARRAY(SELECT item_id FROM descendant_roots)");
  expect(query).not.toContain("kind='folder'");
});

test("the handoff selects only proven parent/trash/shared-root shapes and keeps root/search baseline", () => {
  const parent = input({ parent: "folder" });
  expect(candidateSql(baseline, parent, "recommended")).toBe(
    candidateSql(baseline, parent, "scoped"),
  );
  const roots = input({ view: "shared", type: "folder" });
  expect(candidateSql(baseline, roots, "recommended")).toBe(
    candidateSql(baseline, roots, "set-scope"),
  );
  expect(candidateSql(baseline, input(), "recommended")).toBe(baseline);
  expect(candidateSql(baseline, input({ search: "missing" }), "recommended")).toBe(baseline);
  expect(candidateSql(baseline, input({ view: "shared", search: "report" }), "recommended")).toBe(
    baseline,
  );
});

test("trash remains owner-only, grouped, and independent of parent filtering", () => {
  const query = candidateSql(baseline, input({ view: "trash", parent: "folder" }), "share-union");
  expect(query).toContain("i.owner_id=$1");
  expect(query).toContain("i.trash_root=i.id");
  expect(query).not.toContain("i.parent_id=$6");
  expect(query).not.toContain("eligible");
});

test("limits belong to source result paths, never the eligible share inventory", () => {
  const query = candidateSql(baseline, input(), "share-union");
  const eligible = query.slice(query.indexOf("eligible AS"), query.indexOf("SELECT * FROM"));
  expect(eligible).not.toContain("LIMIT");
  expect(query).toContain(" UNION ");
  expect(query).not.toContain(" UNION ALL ");
});

test("deduplicated union of per-source top K preserves global top K under overlap", () => {
  for (let round = 1; round <= 100; round++) {
    const sources = Array.from({ length: 5 }, (_, source) =>
      Array.from({ length: 240 }, (_, index) => (index * (source + 1) + round) % 301).sort(
        (a, b) => a - b,
      ),
    );

    const unique = sources.map((values) => [...new Set(values)]);
    const global = [...new Set(unique.flat())].sort((a, b) => a - b).slice(0, 101);

    const bounded = [...new Set(unique.flatMap((values) => values.slice(0, 101)))]
      .sort((a, b) => a - b)
      .slice(0, 101);

    expect(bounded).toEqual(global);
  }
});

test("production template checks restore compact bindings and reject drift or unused slots", () => {
  const request = input({ parent: "folder", minSize: 0, search: "needle" });
  const slots = [1, 2, 3, 6, 7, 11, 13];
  const query = candidateSql(baseline, request, "recommended");
  const sql = query.replace(/\$(\d+)/g, (_, slot: string) => `$${slots.indexOf(Number(slot)) + 1}`);
  const template = { input: request, sql, parameterSlots: slots };
  expect(checkProductionTemplates(baseline, [template])).toBe(1);
  expect(() => checkProductionTemplates(baseline, [])).toThrow();
  expect(() =>
    checkProductionTemplates(baseline, [{ ...template, sql: sql + " LIMIT 1" }]),
  ).toThrow();
  expect(() =>
    checkProductionTemplates(baseline, [{ ...template, parameterSlots: [...slots, 8] }]),
  ).toThrow();
  expect(() =>
    checkProductionTemplates(baseline, [{ ...template, parameterSlots: slots.slice(1) }]),
  ).toThrow();
});

test("plan counters retain loops and distinguish physical scans from distinct rows", () => {
  const measured = planCounters({
    "Node Type": "Limit",
    "Actual Rows": 100,
    "Actual Loops": 1,
    Plans: [
      {
        "Node Type": "Index Scan",
        "Relation Name": "hyori_items",
        "Actual Rows": 100,
        "Actual Loops": 1,
        "Rows Removed by Filter": 99900,
      },
      {
        "Node Type": "Nested Loop",
        "Subplan Name": "SubPlan 2",
        "Actual Rows": 0,
        "Actual Loops": 88800,
      },
    ],
  });

  expect(measured.scans[0]!.examined).toBe(100000);
  expect(measured.subplans[0]!.loops).toBe(88800);
});
