import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { sha256 } from "./evidence-bytes.ts";

export const deckRunRoot = fileURLToPath(
  new URL("../../tooling/artcraft/builds/deckcraft-host-v1/run-2026-11-05/", import.meta.url),
);

const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/[\\:\p{Cc}\p{Cf}]/u.test(path) &&
      path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".."),
  );

const recordedRun = z.object({
  schemaVersion: z.literal(1),
  artifactVersion: z.literal("0.14.1-hyori-host.1"),
  deployable: z.literal(false),
  sourceReplayVerified: z.literal(true),
  isolatedOfflineLockedWasmBuild: z.literal(true),
  nativeSyntheticBrowserReopenPassed: z.literal(true),
  cloudPersistenceVerified: z.literal(false),
  pptxFidelityVerified: z.literal(false),
  independentBitIdenticalRebuildVerified: z.literal(false),
  protectedMarksReplaced: z.literal(false),
  fullNoticeContentAuditComplete: z.literal(false),
  compilerGeneratedNoticeAuditComplete: z.literal(false),
  retained: z
    .array(
      z.object({
        path: relativePath,
        bytes: z
          .number()
          .int()
          .nonnegative()
          .max(16 * 1024 * 1024),
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
      }),
    )
    .max(1000),
});

/** Verify the recorded run's retained evidence, not deployment clearance or absent large outputs. */
export async function checkDeckCraftRun(root = deckRunRoot) {
  const run = recordedRun.parse(JSON.parse(await readFile(join(root, "result.json"), "utf8")));

  if (new Set(run.retained.map((file) => file.path)).size !== run.retained.length)
    throw new Error("Duplicate retained evidence path");

  for (const required of [
    "build-manifest.json",
    "build-inputs.json",
    "tool-inputs.json",
    "container-command.json",
    "resolved-graph.json",
    "execution.json",
    "host-bridge.js.source",
    "browser/result.json",
    "browser/events.json",
    "legal/zod/LICENSE",
  ]) {
    if (!run.retained.some((file) => file.path === required))
      throw new Error(`Missing required retained evidence: ${required}`);
  }

  for (const file of run.retained) {
    const bytes = await readFile(join(root, file.path));

    if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256)
      throw new Error(`Retained evidence checksum mismatch: ${file.path}`);
  }

  return run;
}

if (import.meta.main)
  console.log(
    `Verified ${(await checkDeckCraftRun()).retained.length} retained modified-build evidence files; deployable:false`,
  );
