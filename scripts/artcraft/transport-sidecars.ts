import { crc32, gzipSync, inflateRawSync } from "node:zlib";
import { z } from "zod";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const maxAssetBytes = 128 * 1024 * 1024;

const originalAsset = z.object({
  path: relativePath,
  bytes: z.number().int().nonnegative().max(maxAssetBytes),
  sha256: digest,
});

/** Proposed new-manifest transport metadata; never an editor payload identity member. */
export const transportSidecarSchema = z
  .object({
    path: relativePath,
    bytes: z.number().int().positive().max(maxAssetBytes),
    sha256: digest,
    encoding: z.literal("gzip"),
    original: originalAsset,
    encoder: z.literal("gzip-level6-mtime0-os255-v1"),
  })
  .strict();

export type TransportSidecar = z.infer<typeof transportSidecarSchema>;

export type TransportOriginal = z.infer<typeof originalAsset>;

function checkOriginal(original: TransportOriginal, bytes: Buffer) {
  originalAsset.parse(original);

  if (!/\.(?:wasm|js)$/.test(original.path) || original.path.startsWith("legal/"))
    throw new Error("Only executable WASM/JS payloads may have these transport sidecars");

  if (bytes.length !== original.bytes || sha256(bytes) !== original.sha256)
    throw new Error("Original transport asset identity mismatch");
}

/** Compress once during new-bundle assembly, without changing any original payload byte/hash. */
export function createGzipTransportSidecar(original: TransportOriginal, originalBytes: Buffer) {
  checkOriginal(original, originalBytes);
  const bytes = gzipSync(originalBytes, { level: 6 });

  // RFC 1952 OS and timestamp fields do not affect the compressed stream or CRC. Normalize
  // them explicitly; bit-for-bit deflate output is pinned by the resulting global asset hash.
  bytes.writeUInt32LE(0, 4);
  bytes[9] = 255;

  const record = transportSidecarSchema.parse({
    path: `${original.path}.gz`,
    bytes: bytes.length,
    sha256: sha256(bytes),
    encoding: "gzip",
    original,
    encoder: "gzip-level6-mtime0-os255-v1",
  });

  checkGzipTransportSidecar(record, bytes, original);

  return { record, bytes };
}

/** Independent original record must come from verified payload inventory, not sidecar claims. */
export function checkGzipTransportSidecar(
  input: TransportSidecar,
  bytes: Buffer,
  expectedOriginal: TransportOriginal,
) {
  const record = transportSidecarSchema.parse(input);
  originalAsset.parse(expectedOriginal);

  if (
    record.path !== `${expectedOriginal.path}.gz` ||
    record.original.path !== expectedOriginal.path ||
    record.original.bytes !== expectedOriginal.bytes ||
    record.original.sha256 !== expectedOriginal.sha256
  )
    throw new Error("Transport sidecar original binding mismatch");

  if (
    bytes.length !== record.bytes ||
    sha256(bytes) !== record.sha256 ||
    bytes.length < 18 ||
    !bytes.subarray(0, 4).equals(Buffer.from([31, 139, 8, 0])) ||
    bytes.readUInt32LE(4) !== 0 ||
    bytes[8] !== 0 ||
    bytes[9] !== 255
  )
    throw new Error("Transport sidecar bytes/header identity mismatch");

  // Decode exactly one raw deflate stream. gunzip accepts concatenated members, including an
  // appended empty member whose decoded hash would still equal the original asset.
  const decoded = z
    .object({
      buffer: z.instanceof(Buffer),
      engine: z.object({ bytesWritten: z.number().int().positive() }),
    })
    .parse(
      inflateRawSync(bytes.subarray(10), {
        info: true,
        maxOutputLength: Math.max(1, expectedOriginal.bytes),
      }),
    );

  const trailer = 10 + decoded.engine.bytesWritten;

  if (trailer + 8 !== bytes.length)
    throw new Error("Transport gzip must have exactly one member and no trailing bytes");

  if (
    bytes.readUInt32LE(trailer) !== crc32(decoded.buffer) ||
    bytes.readUInt32LE(trailer + 4) !== decoded.buffer.length
  )
    throw new Error("Transport gzip CRC/ISIZE mismatch");

  checkOriginal(expectedOriginal, decoded.buffer);

  return record;
}
