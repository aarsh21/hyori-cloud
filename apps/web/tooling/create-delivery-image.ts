/** Reproducible load-test fixture, not product artwork: deterministic 512×512 RGB noise.
 * Generated pixels are dedicated to CC0. Run: bun apps/web/tooling/create-delivery-image.ts /tmp/delivery.png
 * Then set HYORI_DELIVERY_IMAGE to that absolute path when running measure-delivery.ts seed.
 * The real worker normalizes each 787,252-byte source into a 170,626-byte 256×256 PNG.
 */
import { writeFile } from "node:fs/promises";
import { deflateSync } from "node:zlib";

const size = 512;
const raw = Buffer.alloc((size * 3 + 1) * size);
let random = 134214;

for (let y = 0; y < size; y++) {
  for (let x = 1; x <= size * 3; x++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    raw[y * (size * 3 + 1) + x] = random >>> 24;
  }
}

function chunk(name: string, data: Buffer) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0);
  result.write(name, 4);
  data.copy(result, 8);
  result.writeUInt32BE(Bun.hash.crc32(result.subarray(4, -4)), result.length - 4);

  return result;
}

const ihdr = Buffer.alloc(13);

ihdr.writeUInt32BE(size, 0);

ihdr.writeUInt32BE(size, 4);

ihdr[8] = 8;

ihdr[9] = 2;

const image = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk("IHDR", ihdr),
  chunk("IDAT", deflateSync(raw)),
  chunk("IEND", Buffer.alloc(0)),
]);

await writeFile(process.argv[2]!, image);

console.log(`Generated ${size}×${size} RGB PNG, ${image.length} bytes`);
