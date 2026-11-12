/** Measurement only: transcode existing thumbnail fixtures, without changing the media worker.
 * Run with Bun from the root; pass a directory containing the 18 authenticated PNG responses.
 * Requires ImageMagick with WebP/JPEG. Quality 80 is lossy, not a fidelity equivalence claim.
 */
import { readdir, stat, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

const source = process.argv[2]!;
const images = (await readdir(source)).filter((name) => name.endsWith(".png")).sort();
const temporary = await mkdtemp(join(tmpdir(), "hyori-format-"));
const bytes = { png: 0, webpLossless: 0, webpQuality80: 0, jpegQuality80: 0 };

try {
  for (const name of images) {
    const image = join(source, name);
    bytes.png += (await stat(image)).size;

    for (const [key, options, extension] of [
      ["webpLossless", ["-define", "webp:lossless=true"], "webp"],
      ["webpQuality80", ["-quality", "80"], "webp"],
      ["jpegQuality80", ["-quality", "80"], "jpg"],
    ] as const) {
      const output = join(temporary, `${key}.${extension}`);
      execFileSync("magick", [image, ...options, output]);
      bytes[key] += (await stat(output)).size;
    }
  }

  console.log(
    JSON.stringify({
      images: images.length,
      bytes,
      tool: execFileSync("magick", ["-version"], { encoding: "utf8" }).split("\n")[0],
    }),
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
