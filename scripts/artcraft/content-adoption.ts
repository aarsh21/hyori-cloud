import { lstat, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

export const adoptionRoot = fileURLToPath(
  new URL("../../tooling/artcraft/notice-adoption-v1/", import.meta.url),
);

export const adoptionIndexSha256 =
  "607e858087a0b64f1bf5e30a9fed7fe14e2aaded394e2f05e163e32b9d09f216";

const schema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("express-permission-existing-data-notice-adoption"),
  legalOpinion: z.literal(false),
  fullNoticeAuditComplete: z.literal(false),
  compilerGeneratedNoticeAuditComplete: z.literal(false),
  vendorBytesModified: z.literal(false),
  mappingsModified: z.literal(false),
  files: z.array(
    z.object({
      path: relativePath,
      source: z.string(),
      bytes: z.number().int().nonnegative(),
      sha256: digest,
    }),
  ),
});

/** Independent frozen adoption pin; source-specific terms survive unchanged, including companion AFMs. */
export async function adoptedNoticeFiles(root = adoptionRoot) {
  async function regular(path: string) {
    let current = root;
    const parts = path.split("/");

    for (const [index, name] of ["", ...parts].entries()) {
      current = name ? join(current, name) : current;
      const stat = await lstat(current);

      if (stat.isSymbolicLink() || (index === parts.length ? !stat.isFile() : !stat.isDirectory()))
        throw new Error("Adoption requires regular files/directories, not links");
    }

    return readFile(current);
  }

  const bytes = await regular("index.json");

  if (sha256(bytes) !== adoptionIndexSha256) throw new Error("Notice adoption index pin mismatch");
  const manifest = schema.parse(JSON.parse(bytes.toString()));
  const files = new Map<string, Buffer>();
  const expected = new Set(manifest.files.map((file) => file.path));

  if (expected.size !== manifest.files.length) throw new Error("Duplicate adopted notice");

  for (const file of manifest.files) {
    const body = await regular(`files/${file.path}`);

    if (body.length !== file.bytes || sha256(body) !== file.sha256)
      throw new Error(`Adopted notice checksum mismatch: ${file.path}`);
    files.set(`legal/adopted-data/${file.path}`, body);
  }

  async function walk(relative = "") {
    for (const name of await readdir(join(root, "files", relative))) {
      const path = relative ? `${relative}/${name}` : name;
      const stat = await lstat(join(root, "files", path));

      if (stat.isSymbolicLink()) throw new Error("Adopted notice link rejected");

      if (stat.isDirectory()) await walk(path);
      else if (!stat.isFile() || !expected.has(path))
        throw new Error("Unexpected adopted notice file");
    }
  }

  await walk();

  const permission = files
    .get("legal/adopted-data/adobe-core14/readme.txt")!
    .toString()
    .replace(/\s+/g, " ");

  if (
    !permission.includes("with or without modification") ||
    !permission.includes("this paragraph is not modified")
  )
    throw new Error("AFM-specific adoption permission missing");
  const agl = files.get("legal/adopted-data/adobe-agl/glyphlist.txt")!.toString();

  if (!/^Omegagreek;03A9$/m.test(agl) || !/^Euro;20AC$/m.test(agl))
    throw new Error("Existing mapping compatibility scalar witness missing");
  files.set("legal/adopted-data/index.json", bytes);

  return files;
}

if (import.meta.main)
  console.log(
    `Verified ${(await adoptedNoticeFiles()).size} adopted notice files; unchanged vendor/mapping behavior; legalOpinion:false`,
  );
