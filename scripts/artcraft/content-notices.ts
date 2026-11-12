import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkContentAudit, contentRoot } from "./content-audit.ts";
import { sha256 } from "./evidence-bytes.ts";

/** Preserve a complete leading comment region; never promote a truncated source excerpt to a grant. */
export function sourceNoticePrefix(bytes: Buffer): Buffer {
  let offset = 0;

  while (offset < bytes.length) {
    while (offset < bytes.length && [9, 10, 13, 32].includes(bytes[offset]!)) offset += 1;

    if (bytes[offset] === 47 && bytes[offset + 1] === 47) {
      const newline = bytes.indexOf(10, offset);
      offset = newline < 0 ? bytes.length : newline + 1;
      continue;
    }

    if (bytes[offset] === 47 && bytes[offset + 1] === 42) {
      let depth = 1;
      offset += 2;

      while (depth && offset < bytes.length) {
        if (bytes[offset] === 47 && bytes[offset + 1] === 42) {
          depth += 1;
          offset += 2;
        } else if (bytes[offset] === 42 && bytes[offset + 1] === 47) {
          depth -= 1;
          offset += 2;
        } else offset += 1;
      }

      if (depth) throw new Error("Truncated source notice block");
      continue;
    }

    break;
  }

  return bytes.subarray(0, offset);
}

export async function contentNoticeFiles(root = contentRoot) {
  const { audit, files } = await checkContentAudit(root);
  const output = new Map<string, Buffer>();

  const entries: {
    path: string;
    sha256: string;
    bytes: number;
    source: string;
    member: string;
    scope: string;
  }[] = [];

  const incomplete: { member: string; reason: string }[] = [];

  for (const evidence of audit.evidence) {
    const body = files.get(evidence.id)!;
    let notice: Buffer | undefined;
    let path = `conditions/${evidence.id}.txt`;

    if (evidence.role === "permission-text") notice = body;

    if (evidence.member === "embedded-font-copyrights") {
      notice = body;
      path = "EMBEDDED-FONT-COPYRIGHTS.txt";
    }

    if (
      evidence.role === "copyright-source" &&
      evidence.member.startsWith("library/compiler-builtins/")
    ) {
      let header = sourceNoticePrefix(body);

      if (
        [
          "library/compiler-builtins/libm/src/math/rem_pio2_large.rs",
          "library/compiler-builtins/libm/src/math/erf.rs",
        ].includes(evidence.member)
      ) {
        // Reviewed Sun notices occur after attributes/imports in these exact source members.
        const blocks = [...body.toString().matchAll(/\/\*[\s\S]*?\*\//g)].flatMap((match) =>
          /Copyright \(C\) 1993 by Sun Microsystems/.test(match[0]) ? [match[0]] : [],
        );

        if (blocks.length !== 1 || !blocks[0]!.includes("provided that this notice"))
          throw new Error("Reviewed non-leading Sun notice changed");
        header = Buffer.from(`${blocks[0]}\n`);
      }

      const copyright = body
        .toString()
        .split("\n")
        .filter((line) => /copyright/i.test(line));

      if (copyright.length && copyright.every((line) => header.toString().includes(line))) {
        notice = header;
        path = `runtime-source-notices/${evidence.id}.txt`;
      } else
        incomplete.push({
          member: evidence.member,
          reason:
            "Per-file copyright is not wholly in a leading comment region; exact complete source is retained in audit evidence, not silently truncated or treated as cleared.",
        });
    }

    if (!notice) continue;
    output.set(path, notice);
    entries.push({
      path,
      sha256: sha256(notice),
      bytes: notice.length,
      source: evidence.source,
      member: evidence.member,
      scope: evidence.scope,
    });
  }

  output.set(
    "CONTENT-NOTICES.md",
    Buffer.from(
      `# Experimental content notice supplement\n\nTechnical redistribution evidence, not legal opinion or deployment approval. All permission/condition files preserve their original bytes; generated font-copyright text preserves the observed sfnt records and source extents. Applicable mixed licences are not replaced with a root MIT/Apache label.\n\nSome compiler/source notices are conservative and may cover unlinked or non-wasm source files. This does not assert that every listed component is linked, impose all listed licences on Hyori, grant trademark rights, or resolve opaque/transformed WASM content.\n\nCompiler-builtins: MIT AND Apache-2.0 WITH LLVM-exception. Do not drop MIT notice requirements by citing only the LLVM exception. Fonts retain their own UFL/OFL/Bitstream/MIT conditions, reserved names and copyright. WHATWG, Unicode/ICU/CLDR, Foxit, Adobe CMap, ICC and Lucide/Feather material have separate content dispositions.\n\nThe full audit manifest records every discovered item's disposition and exact remaining actions. Adobe-derived AFM/specification metric and encoding rights, source-to-output correspondence, applicable generated-data provenance and protected marks remain unresolved. No original editor ZIP or modified WASM was rewritten. This supplement is not yet wired into acquisition or runtime delivery.\n`,
    ),
  );
  output.set(
    "notice-manifest.json",
    Buffer.from(
      `${JSON.stringify({ schemaVersion: 1, deployable: false, fullNoticeAuditComplete: false, compilerGeneratedNoticeAuditComplete: false, legalOpinion: false, entries, incomplete, remaining: "Integrate and verify notice delivery together with resolution of the audit's rights/provenance/marks gates before enabling distribution." }, null, 2)}\n`,
    ),
  );

  return output;
}

if (import.meta.main) {
  const [, , destination, root] = process.argv;

  if (!destination || ![3, 4].includes(process.argv.length))
    throw new Error("Usage: bun scripts/artcraft/content-notices.ts NEW_OUTPUT [AUDIT_ROOT]");
  const output = resolve(destination);
  await mkdir(output);
  const files = await contentNoticeFiles(root);

  for (const [path, bytes] of files) {
    await mkdir(dirname(join(output, path)), { recursive: true });
    await writeFile(join(output, path), bytes, { flag: "wx" });
  }

  console.log(
    `Wrote ${files.size} content notice files; deployment and full-audit gates remain false.`,
  );
}
