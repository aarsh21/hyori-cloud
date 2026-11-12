/** Redistributable benchmark inputs, not product artwork. Run with Bun; requires ImageMagick.
 * bun apps/web/tooling/create-delivery-photographs.ts /absolute/path/to/photographs
 * Set HYORI_DELIVERY_IMAGES to the JSON array of output PNG paths for measure-delivery.ts seed.
 * Licenses are recorded by scikit-image v0.25.2, skimage/data/_fetchers.py.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const photographs = [
  [
    "astronaut.png",
    "88431cd9653ccd539741b555fb0a46b61558b301d4110412b5bc28b5e3ea6cb5",
    "NASA, public domain",
  ],
  [
    "chelsea.png",
    "596aa1e7cb875eb79f437e310381d26b338a81c2da23439704a73c4651e8c4bb",
    "Stefan van der Walt, CC0",
  ],
  [
    "coffee.png",
    "cc02f8ca188b167c775a7101b5d767d1e71792cf762c33d6fa15a4599b5a8de7",
    "Rachel Michetti, CC0; courtesy of Pikolo Espresso Bar",
  ],
  [
    "rocket.jpg",
    "c2dd0de7c538df8d111e479619b129464d0269d0ae5fd18ca91d33a7fdfea95c",
    "SpaceX, public domain",
  ],
  [
    "hubble_deep_field.jpg",
    "3a19c5dd8a927a9334bb1229a6d63711b1c0c767fb27e2286e7c84a3e2c2f5f4",
    "NASA, public domain",
  ],
] as const;

const destination = resolve(process.argv[2]!);
const temporary = await mkdtemp(join(tmpdir(), "hyori-delivery-photos-"));
const manifest = [];

try {
  await mkdir(destination, { recursive: true });

  for (const [name, expected, license] of photographs) {
    const source = `https://raw.githubusercontent.com/scikit-image/scikit-image/v0.25.2/skimage/data/${name}`;
    const response = await fetch(source);

    if (!response.ok) throw new Error(`Photograph download failed: ${response.status}`);

    const bytes = new Uint8Array(await response.arrayBuffer());
    const sha256 = createHash("sha256").update(bytes).digest("hex");

    if (sha256 !== expected) throw new Error(`Photograph checksum differs: ${name}`);

    const input = join(temporary, name);
    const output = join(destination, name.replace(/\.(png|jpg)$/, ".png"));
    await writeFile(input, bytes);
    // Strip container metadata only; retain source resolution and RGB pixels, with no resizing.
    // The legacy PNG worker refuses color-metadata chunks emitted from tagged inputs.
    execFileSync("magick", [input, "-strip", `PNG24:${output}`]);
    manifest.push({ source, sha256, license, output });
  }

  await writeFile(join(destination, "provenance.json"), JSON.stringify(manifest, null, 2));
  console.log(JSON.stringify(manifest.map((image) => image.output)));
} finally {
  await rm(temporary, { recursive: true, force: true });
}
