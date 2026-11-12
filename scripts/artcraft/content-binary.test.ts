import { expect, test } from "bun:test";
import { discoverSfnt, inspectWasm, sfntAt } from "./content-binary.ts";

function leb(value: number): Buffer {
  const bytes: number[] = [];

  do {
    const low = value & 127;
    value = Math.floor(value / 128);
    bytes.push(low | (value ? 128 : 0));
  } while (value);

  return Buffer.from(bytes);
}

interface SyntheticSegment {
  offset: number;
  bytes: Buffer;
}

function wasm(segments: SyntheticSegment[]): Buffer {
  const parts = segments.map((segment) =>
    Buffer.concat([
      Buffer.from([0, 0x41]),
      leb(segment.offset),
      Buffer.from([0x0b]),
      leb(segment.bytes.length),
      segment.bytes,
    ]),
  );

  const data = Buffer.concat([leb(parts.length), ...parts]);

  return Buffer.concat([Buffer.from([0, 97, 115, 109, 1, 0, 0, 0, 11]), leb(data.length), data]);
}

function sfnt(): Buffer {
  const names = Buffer.from("Synthetic Test Face", "utf16le").swap16();
  const name = Buffer.alloc(18 + names.length);
  name.writeUInt16BE(1, 2);
  name.writeUInt16BE(18, 4);
  name.writeUInt16BE(3, 6);
  name.writeUInt16BE(1, 8);
  name.writeUInt16BE(0x409, 10);
  name.writeUInt16BE(1, 12);
  name.writeUInt16BE(names.length, 14);
  names.copy(name, 18);
  const head = Buffer.alloc(16);
  head.writeUInt32BE(0x5f0f3cf5, 12);

  const fields = [
    { tag: "head", bytes: head },
    { tag: "cmap", bytes: Buffer.alloc(4) },
    { tag: "name", bytes: name },
  ];

  const header = Buffer.alloc(60);
  header.writeUInt32BE(0x10000);
  header.writeUInt16BE(3, 4);
  let offset = header.length;
  fields.forEach((field, index) => {
    header.write(field.tag, 12 + index * 16);
    header.writeUInt32BE(offset, 20 + index * 16);
    header.writeUInt32BE(field.bytes.length, 24 + index * 16);
    offset += field.bytes.length;
  });

  return Buffer.concat([header, ...fields.map((field) => field.bytes)]);
}

test("static inspection reconstructs split data and zero-fill without instantiating WASM", () => {
  const result = inspectWasm(
    wasm([
      { offset: 0, bytes: Buffer.from("first") },
      { offset: 8, bytes: Buffer.from("second") },
    ]),
  );

  expect(result.memory).toEqual(
    Buffer.concat([Buffer.from("first"), Buffer.alloc(3), Buffer.from("second")]),
  );
  expect(result.segments.length).toBe(2);
});

test("static reconstruction respects later overlapping active data", () => {
  expect(
    inspectWasm(
      wasm([
        { offset: 0, bytes: Buffer.from("abc") },
        { offset: 1, bytes: Buffer.from("XY") },
      ]),
    ).memory.toString(),
  ).toBe("aXY");
});

test("unsupported offset expressions are an explicit audit failure, not silent absence", () => {
  const bytes = wasm([{ offset: 0, bytes: Buffer.from("x") }]);
  const at = bytes.indexOf(0x41, 10);
  bytes[at] = 0x23;
  expect(() => inspectWasm(bytes)).toThrow("Nonconstant");
});

test("truncated sections and overflowing addresses are rejected before allocation", () => {
  const bytes = wasm([{ offset: 0, bytes: Buffer.from("x") }]);
  expect(() => inspectWasm(bytes.subarray(0, -1))).toThrow("Truncated");
  expect(() => inspectWasm(wasm([{ offset: 300 * 1024 * 1024, bytes: Buffer.from("x") }]))).toThrow(
    "memory bound",
  );
});

test("signature-like text is not counted as a font", () => {
  expect(discoverSfnt(Buffer.from("OTTO is text, not an actual font"))).toEqual([]);
});

test("font discovery reads actual sfnt table/name structure and source extent", () => {
  const bytes = sfnt();
  const font = sfntAt(bytes, 0);
  expect(font?.names).toEqual([{ id: 1, text: "Synthetic Test Face" }]);
  const memory = Buffer.concat([Buffer.alloc(17), bytes]);
  expect(discoverSfnt(memory)[0]?.offset).toBe(17);
  expect(discoverSfnt(memory)[0]?.sha256).toBe(font?.sha256);
});

test("font bounds, duplicate tables and forged head magic are rejected", () => {
  const bytes = sfnt();
  expect(sfntAt(bytes.subarray(0, -1), 0)).toBeNull();
  const duplicate = Buffer.from(bytes);
  duplicate.write("head", 28);
  expect(sfntAt(duplicate, 0)).toBeNull();
  const magic = Buffer.from(bytes);
  magic.writeUInt32BE(0, 72);
  expect(sfntAt(magic, 0)).toBeNull();
});
