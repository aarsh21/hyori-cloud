import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  conditions,
  itemId,
  fixtureOwner,
  consumerSourceSnapshot,
  discoverConsumerPackages,
  journeys,
  percentile,
  seedItemsSql,
  summarize,
  type TimingRow,
} from "./benchmark-rust-metadata.ts";

function row(elapsedMs: number, ok = true): TimingRow {
  return {
    phase: "warm-sequential",
    journey: "fixture",
    sample: 0,
    worker: 0,
    startedAt: "2026-11-05T00:00:00.000Z",
    elapsedMs,
    ok,
    rows: ok ? 100 : null,
    idDigest: null,
    errorCode: ok ? null : "SDK_TRANSPORT",
  };
}

describe("metadata characterization accounting", () => {
  test("uses nearest-rank percentiles without mutating input", () => {
    const values = [100, ...Array.from({ length: 99 }, (_, index) => index + 1)];
    expect(percentile(values, 0.5)).toBe(50);
    expect(percentile(values, 0.95)).toBe(95);
    expect(values[0]).toBe(100);
  });

  test("retains failures and timeouts in counts and quantiles", () => {
    const rows = [
      ...Array.from({ length: 94 }, () => row(5)),
      ...Array.from({ length: 6 }, () => row(35000, false)),
    ];

    expect(summarize(rows, 150)).toMatchObject({
      samples: 100,
      failures: 6,
      p50Ms: 5,
      p95Ms: 35000,
      maxMs: 35000,
      passesCandidate: false,
    });
  });

  test("a fast functional failure cannot pass a latency budget", () => {
    expect(summarize([row(1, false)], 150).passesCandidate).toBe(false);
    expect(summarize([row(151)], 150).passesCandidate).toBe(false);
    expect(summarize([row(150)], 150).passesCandidate).toBe(true);
  });

  test("rejects missing and non-finite observations rather than manufacturing percentiles", () => {
    expect(() => percentile([], 0.95)).toThrow();
    expect(() => percentile([Number.NaN], 0.95)).toThrow();
    expect(() => percentile([1], 0)).toThrow();
  });

  test("permission assertions derive ownership from the fixture rather than trusting returned ownership", () => {
    expect(fixtureOwner(11200)).toBe(0);
    expect(fixtureOwner(11201)).toBe(1);
    expect(fixtureOwner(12201)).toBe(2);
    expect(fixtureOwner(50000)).toBe(5);
    expect(fixtureOwner(100000)).toBe(9);
    expect(() => fixtureOwner(0)).toThrow();
    expect(() => fixtureOwner(Number.NaN)).toThrow();
  });

  test("records real public-consumer sources without importing the SDK or starting services", async () => {
    const snapshot = await consumerSourceSnapshot();
    expect(snapshot.versions).toHaveLength(snapshot.packageRoots.length);
    expect(snapshot.packageRoots).toEqual(expect.arrayContaining(["client-sdk", "api", "lib"]));
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files.some((file) => file.path === "packages/client-sdk/src/client.ts")).toBe(
      true,
    );
    expect(
      snapshot.files.some((file) => file.path === "packages/api/src/generated/operations.ts"),
    ).toBe(true);
    expect(snapshot.files.some((file) => file.path === "packages/api/src/backend-proxy.ts")).toBe(
      true,
    );
    expect(snapshot.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
  });

  test("discovers only actual owned runtime dependencies and works after legacy core is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "hyori-benchmark-packages-"));

    try {
      for (const name of ["client-sdk", "api", "lib"]) {
        await mkdir(join(directory, name));
        await writeFile(
          join(directory, name, "package.json"),
          JSON.stringify({
            name: `@hyori-cloud/${name}`,
            dependencies: { "@hyori-cloud/lib": "workspace:*" },
          }),
        );
      }

      expect(await discoverConsumerPackages(directory)).toEqual(["client-sdk", "api", "lib"]);
      await mkdir(join(directory, "core"));
      await writeFile(
        join(directory, "core", "package.json"),
        JSON.stringify({ name: "@hyori-cloud/core" }),
      );
      // An unreferenced leftover directory is not part of current runtime provenance.
      expect(await discoverConsumerPackages(directory)).toEqual(["client-sdk", "api", "lib"]);
      await writeFile(
        join(directory, "api", "package.json"),
        JSON.stringify({
          name: "@hyori-cloud/api",
          dependencies: { "@hyori-cloud/core": "workspace:*" },
        }),
      );
      expect(await discoverConsumerPackages(directory)).toEqual([
        "client-sdk",
        "api",
        "lib",
        "core",
      ]);
      await rm(join(directory, "core"), { recursive: true });
      // A still-declared missing dependency is a broken fixture, not permission to omit evidence.
      await expect(discoverConsumerPackages(directory)).rejects.toThrow();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("workload and measurement conditions are fixed before execution", () => {
    expect(conditions.items).toBe(100000);
    expect(conditions.samplesPerJourney).toBe(100);
    expect(conditions.concurrency).toBe(10);
    expect(conditions.incomingGrants).toBeGreaterThan(1000);
    expect(journeys).toHaveLength(13);
    expect(journeys.every((journey) => journey.input.limit === 100)).toBe(true);
    expect(seedItemsSql()).toContain("generate_series(1,100000)");
    expect(seedItemsSql()).toContain("generate_series(12201,13400)");
    expect(itemId(1300)).toBe("item_001300");
  });
});
