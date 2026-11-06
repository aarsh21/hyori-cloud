import { expect, test } from "bun:test";
import { gzipSync } from "node:zlib";
import { checkGzipTransportSidecar, createGzipTransportSidecar } from "./transport-sidecars.ts";
import { sha256 } from "./evidence-bytes.ts";

const body = Buffer.from("synthetic wasm transport input\n".repeat(100));

const original = {
  path: "wordcraft/new-version/engine-0123456789abcdef_bg.wasm",
  bytes: body.length,
  sha256: sha256(body),
};

test("deterministic gzip preserves original identity and validates exact bounded decode", () => {
  const first = createGzipTransportSidecar(original, body);
  const second = createGzipTransportSidecar(original, body);

  expect(first.bytes.equals(second.bytes)).toBe(true);
  expect(first.record.original).toEqual(original);
  expect(first.bytes.readUInt32LE(4)).toBe(0);
  expect(first.bytes[9]).toBe(255);
  expect(checkGzipTransportSidecar(first.record, first.bytes, original)).toEqual(first.record);
  expect(sha256(body)).toBe(original.sha256);
});

test("sidecar binds to independently verified original, not its own digest claims", () => {
  const { record, bytes } = createGzipTransportSidecar(original, body);

  expect(() =>
    checkGzipTransportSidecar(
      { ...record, original: { ...original, sha256: "0".repeat(64) } },
      bytes,
      original,
    ),
  ).toThrow("binding");
  expect(() =>
    checkGzipTransportSidecar({ ...record, path: "foreign/asset.gz" }, bytes, original),
  ).toThrow("binding");
  expect(() => createGzipTransportSidecar(original, Buffer.from("different"))).toThrow("identity");
});

test("changed encoded bytes, truncated streams, noncanonical headers and wrong decoded content fail", () => {
  const { record, bytes } = createGzipTransportSidecar(original, body);
  const changed = Buffer.from(bytes);
  changed[12] = changed[12]! ^ 1;

  expect(() => checkGzipTransportSidecar(record, changed, original)).toThrow("identity");
  const truncated = bytes.subarray(0, bytes.length - 2);

  expect(() =>
    checkGzipTransportSidecar(
      { ...record, bytes: truncated.length, sha256: sha256(truncated) },
      truncated,
      original,
    ),
  ).toThrow();
  const dated = Buffer.from(bytes);
  dated.writeUInt32LE(1, 4);

  expect(() =>
    checkGzipTransportSidecar({ ...record, sha256: sha256(dated) }, dated, original),
  ).toThrow("header");

  const different = createGzipTransportSidecar(
    { ...original, sha256: sha256(Buffer.alloc(body.length)) },
    Buffer.alloc(body.length),
  );

  expect(() =>
    checkGzipTransportSidecar({ ...different.record, original }, different.bytes, original),
  ).toThrow("identity");
});

test("decode bound rejects oversized and concatenated gzip members even with valid encoded hash", () => {
  const { record, bytes } = createGzipTransportSidecar(original, body);
  const oversized = gzipSync(Buffer.alloc(body.length + 1));
  oversized.writeUInt32LE(0, 4);
  oversized[9] = 255;
  const concatenated = Buffer.concat([bytes, gzipSync(Buffer.from("extra"))]);

  const emptyMember = Buffer.concat([bytes, gzipSync(Buffer.alloc(0))]);
  const trailing = Buffer.concat([bytes, Buffer.from([0])]);

  for (const candidate of [oversized, concatenated, emptyMember, trailing])
    expect(() =>
      checkGzipTransportSidecar(
        { ...record, bytes: candidate.length, sha256: sha256(candidate) },
        candidate,
        original,
      ),
    ).toThrow();
});

test("sidecars reject legal files, paths outside payload types and oversized original claims", () => {
  for (const path of ["legal/notice.js", "wordcraft/v/index.html", "../engine.wasm"])
    expect(() => createGzipTransportSidecar({ ...original, path }, body)).toThrow();

  expect(() =>
    createGzipTransportSidecar({ ...original, bytes: 128 * 1024 * 1024 + 1 }, body),
  ).toThrow();
});
