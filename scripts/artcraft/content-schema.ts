import { z } from "zod";

export const digest = z.string().regex(/^[a-f0-9]{64}$/);

export const relativePath = z
  .string()
  .min(1)
  .refine(
    (path) =>
      !/[\\:\p{Cc}\p{Cf}]/u.test(path) &&
      path.split("/").every((part) => Boolean(part) && part !== "." && part !== ".."),
  );

const font = z.object({
  offset: z.number().int().nonnegative(),
  bytes: z.number().int().positive(),
  sha256: digest,
  names: z.array(z.object({ id: z.number().int(), text: z.string() })),
});

export const sourceRecord = z.object({
  id: z.string(),
  url: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: digest,
});

export const fetchRecord = z.object({
  files: z.array(sourceRecord.extend({ path: relativePath })),
  failures: z.array(z.object({ id: z.string(), url: z.string(), error: z.string() })),
});

export const discoverySchema = z.object({
  schemaVersion: z.literal(1),
  deployable: z.literal(false),
  fullNoticeAuditComplete: z.literal(false),
  method: z.string(),
  sources: z.array(sourceRecord),
  assets: z.array(
    z.object({
      artifact: z.string(),
      path: relativePath,
      bytes: z.number().int().nonnegative(),
      sha256: digest,
      kind: z.string(),
      inlineText: z.string().optional(),
    }),
  ),
  binaries: z.array(
    z.object({
      artifact: z.string(),
      path: relativePath,
      sections: z.array(
        z.object({
          id: z.number(),
          bytes: z.number(),
          sha256: digest,
          name: z.string().optional(),
        }),
      ),
      producers: z.array(z.object({ field: z.string(), name: z.string(), version: z.string() })),
      rustSourceCommits: z.array(z.string()),
      segments: z.array(
        z.object({ offset: z.number().nullable(), bytes: z.number(), sha256: digest }),
      ),
      fonts: z.array(font),
    }),
  ),
  references: z.array(
    z.object({
      id: z.string(),
      source: z.string(),
      member: relativePath,
      sha256: digest,
      kind: z.string(),
      bytes: z.number(),
      matches: z.array(z.object({ artifact: z.string(), offset: z.number() })),
      font: font.nullable().optional(),
      header: z.string().optional(),
    }),
  ),
  sites: z.array(
    z.object({
      source: z.string(),
      member: relativePath,
      line: z.number(),
      expression: z.string(),
      resolved: z.string().nullable(),
    }),
  ),
});

export const rustSourceSchema = z.object({
  schemaVersion: z.literal(1),
  url: z.string(),
  sha256: digest,
  bytes: z.number(),
  rustCommit: z.string(),
  files: z.array(
    z.object({
      member: relativePath,
      sha256: digest,
      bytes: z.number(),
      copyright: z.array(z.string()),
      permission: z.array(z.string()),
    }),
  ),
  evidence: z.array(
    z.object({ member: relativePath, path: relativePath, sha256: digest, bytes: z.number() }),
  ),
  scope: z.string(),
});

export const evidenceSchema = z.object({
  id: z.string(),
  scope: z.enum(["legacy", "audit"]),
  path: relativePath,
  sha256: digest,
  bytes: z.number(),
  role: z.enum([
    "permission-text",
    "copyright-source",
    "provenance",
    "generator-source",
    "font-metadata",
  ]),
  source: z.string(),
  member: z.string(),
});

export const materialSchema = z.object({
  id: z.string(),
  category: z.enum([
    "distributed-file",
    "embedded-font",
    "source-resource",
    "unresolved-include",
    "compiler-source",
    "compiler-runtime",
    "output-generator",
    "unmapped-wasm",
  ]),
  artifacts: z.array(z.string()),
  disposition: z.enum([
    "notice-evidence-reviewed",
    "conservative-notice-evidence",
    "unresolved",
    "protected-mark-gate",
    "not-shipped-tool",
  ]),
  evidence: z.array(z.string()),
  obligations: z.array(z.string()).min(1),
  assessment: z.string().min(1),
  remaining: z.array(z.string()),
});

export type Material = z.infer<typeof materialSchema>;

export const auditSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("bounded-content-review-not-legal-opinion"),
  deployable: z.literal(false),
  fullNoticeAuditComplete: z.literal(false),
  compilerGeneratedNoticeAuditComplete: z.literal(false),
  protectedMarksCleared: z.literal(false),
  legalOpinion: z.literal(false),
  scope: z.object({
    discoverySha256: digest,
    discoveredItemIds: z.array(z.string()),
    rustSourceArchive: sourceRecord,
  }),
  evidence: z.array(evidenceSchema),
  materials: z.array(materialSchema),
  reviewedPolicies: z.array(
    z.object({ id: z.string(), text: z.string(), evidence: z.array(z.string()) }),
  ),
  unresolved: z.array(
    z.object({ id: z.string(), description: z.string(), materials: z.array(z.string()) }),
  ),
});
