import { sha256 } from "./evidence-bytes.ts";

class WasmReader {
  offset = 0;
  constructor(readonly bytes: Buffer) {}
  byte() {
    if (this.offset >= this.bytes.length) throw new Error("Truncated WASM field");

    return this.bytes[this.offset++]!;
  }
  unsigned() {
    let value = 0;

    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();

      if (index === 4 && byte & 0xf0) throw new Error("WASM integer overflow");
      value += (byte & 127) * 2 ** (7 * index);

      if (!(byte & 128)) return value;
    }

    throw new Error("WASM integer overflow");
  }
  signed() {
    let value = 0;
    let shift = 0;

    for (let index = 0; index < 5; index += 1) {
      const byte = this.byte();
      value += (byte & 127) * 2 ** shift;
      shift += 7;

      if (!(byte & 128)) {
        if (byte & 64) value -= 2 ** shift;

        if (value < -2147483648 || value > 2147483647) throw new Error("WASM signed overflow");

        return value;
      }
    }

    throw new Error("WASM signed overflow");
  }
  take(length: number) {
    const end = this.offset + length;

    if (end > this.bytes.length) throw new Error("Truncated WASM payload");
    const value = this.bytes.subarray(this.offset, end);
    this.offset = end;

    return value;
  }
  string() {
    return new TextDecoder("utf-8", { fatal: true }).decode(this.take(this.unsigned()));
  }
}

/** Static data parsing only, never compilation, instantiation or vendor code execution. */
export function inspectWasm(bytes: Buffer) {
  if (!bytes.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0])))
    throw new Error("Unsupported WASM header");
  const reader = new WasmReader(bytes);
  reader.offset = 8;
  const sections: { id: number; bytes: number; sha256: string; name?: string }[] = [];
  const segments: { offset: number | null; bytes: Buffer }[] = [];
  const producers: { field: string; name: string; version: string }[] = [];

  while (reader.offset < bytes.length) {
    const id = reader.byte();
    const body = reader.take(reader.unsigned());
    const section = new WasmReader(body);
    const record: (typeof sections)[number] = { id, bytes: body.length, sha256: sha256(body) };

    if (id === 0) {
      record.name = section.string();

      if (record.name === "producers") {
        const count = section.unsigned();

        if (count > 100) throw new Error("WASM producer bound");

        for (let i = 0; i < count; i += 1) {
          const field = section.string();
          const n = section.unsigned();

          if (n > 100) throw new Error("WASM producer bound");

          for (let j = 0; j < n; j += 1)
            producers.push({ field, name: section.string(), version: section.string() });
        }
      }
    }

    if (id === 11) {
      const count = section.unsigned();

      if (count > 200000 || count > body.length / 2) throw new Error("WASM segment bound");

      for (let i = 0; i < count; i += 1) {
        const flags = section.unsigned();
        let offset: number | null = null;

        if (flags === 2 && section.unsigned() !== 0)
          throw new Error("Nonzero WASM memory unsupported");

        if (flags === 0 || flags === 2) {
          if (section.byte() !== 0x41) throw new Error("Nonconstant WASM data offset");
          offset = section.signed();

          if (offset < 0 || section.byte() !== 0x0b) throw new Error("Invalid WASM data offset");
        } else if (flags !== 1) throw new Error("Unsupported WASM segment flags");
        segments.push({ offset, bytes: section.take(section.unsigned()) });
      }

      if (section.offset !== body.length) throw new Error("Unexpected WASM data tail");
    }

    sections.push(record);
  }

  const end = segments.reduce(
    (end, segment) =>
      segment.offset === null ? end : Math.max(end, segment.offset + segment.bytes.length),
    0,
  );

  if (end > 256 * 1024 * 1024) throw new Error("Static WASM memory bound");
  const memory = Buffer.alloc(end);

  for (const segment of segments)
    if (segment.offset !== null) segment.bytes.copy(memory, segment.offset);

  const rustSourceCommits = [
    ...new Set(
      [...bytes.toString("latin1").matchAll(/\/rustc\/([a-f0-9]{40})\//g)].map(
        (match) => match[1]!,
      ),
    ),
  ].sort();

  return { sections, producers, segments, memory, rustSourceCommits };
}

/** Identify actual sfnt table structure; signatures alone are not a font identification. */
export function sfntAt(bytes: Buffer, base: number) {
  if (base < 0 || base + 12 > bytes.length) return null;
  const signature = bytes.readUInt32BE(base);

  if (signature !== 0x00010000 && signature !== 0x4f54544f) return null;
  const count = bytes.readUInt16BE(base + 4);

  if (!count || count > 128 || base + 12 + count * 16 > bytes.length) return null;
  const tables = new Map<string, { offset: number; bytes: number }>();
  let length = 12 + count * 16;

  for (let index = 0; index < count; index += 1) {
    const position = base + 12 + index * 16;
    const tag = bytes.toString("ascii", position, position + 4);
    const offset = bytes.readUInt32BE(position + 8);
    const size = bytes.readUInt32BE(position + 12);

    if (
      !/^[A-Za-z0-9 /]{4}$/.test(tag) ||
      tables.has(tag) ||
      offset < 12 + count * 16 ||
      offset + size > 32 * 1024 * 1024 ||
      base + offset + size > bytes.length
    )
      return null;
    tables.set(tag, { offset, bytes: size });
    length = Math.max(length, offset + size);
  }

  const head = tables.get("head");
  const names = tables.get("name");

  if (
    !head ||
    head.bytes < 16 ||
    bytes.readUInt32BE(base + head.offset + 12) !== 0x5f0f3cf5 ||
    !names ||
    !tables.has("cmap")
  )
    return null;
  const table = bytes.subarray(base + names.offset, base + names.offset + names.bytes);

  if (table.length < 6) return null;
  const records = table.readUInt16BE(2);
  const storage = table.readUInt16BE(4);

  if (6 + records * 12 > storage || storage > table.length) return null;
  const text: { id: number; text: string }[] = [];

  for (let i = 0; i < records; i += 1) {
    const position = 6 + i * 12;
    const platform = table.readUInt16BE(position);
    const id = table.readUInt16BE(position + 6);

    if (![0, 1, 2, 3, 4, 6, 13, 14].includes(id) || ![0, 3].includes(platform)) continue;
    const size = table.readUInt16BE(position + 8);
    const offset = storage + table.readUInt16BE(position + 10);

    if (size % 2 || offset + size > table.length) return null;

    const value = new TextDecoder("utf-16be", { fatal: true }).decode(
      table.subarray(offset, offset + size),
    );

    if (!text.some((item) => item.id === id && item.text === value)) text.push({ id, text: value });
  }

  return {
    offset: base,
    bytes: length,
    sha256: sha256(bytes.subarray(base, base + length)),
    names: text,
  };
}

export function discoverSfnt(memory: Buffer) {
  const fonts: NonNullable<ReturnType<typeof sfntAt>>[] = [];

  for (const magic of [Buffer.from([0, 1, 0, 0]), Buffer.from("OTTO")]) {
    let offset = memory.indexOf(magic);

    while (offset >= 0) {
      const font = sfntAt(memory, offset);

      if (font) fonts.push(font);
      offset = memory.indexOf(magic, offset + (font?.bytes ?? 1));
    }
  }

  return fonts.sort((a, b) => a.offset - b.offset);
}
