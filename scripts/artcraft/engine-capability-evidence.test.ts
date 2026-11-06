import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import handoff from "../../tooling/artcraft/runtime-all4-v2.json" with { type: "json" };

const evidence = z.object({
  browser: z.string(),
  runtimeManifestSha256: z.literal(handoff.manifestSha256),
  syntheticOnly: z.literal(true),
  sandboxEnabled: z.literal(true),
  isolatedBrowserEnvironment: z.literal(true),
  focusStealingInDispatch: z.literal(false),
  actualHttpPerformanceBaseline: z.literal(false),
  results: z
    .array(
      z.object({
        app: z.string(),
        version: z.string(),
        attempts: z
          .array(
            z.object({
              focus: z.enum(["parent", "editor"]),
              target: z.string(),
              available: z.boolean(),
              trusted: z.boolean().nullable(),
              focusUnchanged: z.boolean(),
              documentFocused: z.boolean(),
              nativeSaveEvents: z.number().int().nonnegative(),
            }),
          )
          .length(8),
        trustedControlNativeSaves: z.number().int(),
        errors: z.array(z.string()),
        observed: z.object({
          saves: z
            .array(
              z.object({
                type: z.string(),
                bytes: z.number().positive(),
                sha256: z.string().regex(/^[a-f0-9]{64}$/),
                prefix: z.array(z.number().int().min(0).max(255)),
              }),
            )
            .min(2),
        }),
      }),
    )
    .length(4),
});

test("retained real-current-engine prototype proves focused native save but not a focus-independent autosave API", async () => {
  const report = evidence.parse(
    JSON.parse(
      await readFile("tooling/artcraft/capabilities-v1/browser-isolated/result.json", "utf8"),
    ),
  );

  expect(report.browser).toBe("156.0.8078.4");
  expect(report.results.map((result) => ({ app: result.app, version: result.version }))).toEqual(
    handoff.editors.map(({ app, version }) => ({ app, version })),
  );

  for (const result of report.results) {
    expect(result.trustedControlNativeSaves).toBe(1);
    expect(result.errors).toEqual([]);

    for (const attempt of result.attempts) {
      expect(attempt.focusUnchanged).toBe(true);

      if (!attempt.available) continue;
      expect(attempt.trusted).toBe(false);
      expect(attempt.documentFocused).toBe(attempt.focus === "editor");
      expect(attempt.nativeSaveEvents).toBe(
        attempt.focus === "editor" && attempt.target === "canvas" ? 1 : 0,
      );
    }

    for (const save of result.observed.saves) expect(save.type).toBe(`${result.app}:save`);
  }
});
