import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

const MANIFEST = "runtime-bundle-manifest.json";

const Manifest = z.looseObject({
  purpose: z.string(),
  editors: z.array(z.looseObject({ app: z.string(), version: z.string(), assetUrl: z.string() })),
});

export type EditorBundle = {
  readonly directory: string;
  readonly manifestSha256: string;
  readonly purpose: string;
  readonly editors: readonly { app: string; version: string; assetUrl: string }[];
};

/**
 * The exact bundle handed over for this run, refused if its manifest isn't the pinned one. The
 * backend verifies its whole inventory again on start: this only keeps the run from being
 * misattributed, and tells the scenarios which editors are really in it.
 */
export function readEditorBundle(directoryArgument: string, expectedSha256: string): EditorBundle {
  const directory = resolve(directoryArgument);
  const bytes = readFileSync(join(directory, MANIFEST));
  const manifestSha256 = createHash("sha256").update(bytes).digest("hex");

  if (manifestSha256 !== expectedSha256) {
    throw new Error(`${MANIFEST} is ${manifestSha256}, not the pinned ${expectedSha256}.`);
  }

  const { purpose, editors } = Manifest.parse(JSON.parse(bytes.toString()));

  return {
    directory,
    manifestSha256,
    purpose,
    editors: editors.map(({ app, version, assetUrl }) => ({ app, version, assetUrl })),
  };
}
