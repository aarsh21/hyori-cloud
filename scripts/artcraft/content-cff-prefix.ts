/** Research-only CFF1 structural/prefix decoder. Never draws or evaluates glyph outlines. */
class CffBytes {
  constructor(readonly body: Buffer) {
    if (body.length > 1024 * 1024) throw new Error("Research CFF size limit");
  }
  range(offset: number, size: number) {
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(size) ||
      offset < 0 ||
      size < 0 ||
      offset + size > this.body.length
    )
      throw new Error("CFF data bounds");

    return this.body.subarray(offset, offset + size);
  }
  uint(offset: number, size: number) {
    return this.range(offset, size).readUIntBE(0, size);
  }
  index(offset: number) {
    const count = this.uint(offset, 2);

    if (count > 4096) throw new Error("CFF INDEX count limit");

    if (!count) return { entries: [], end: offset + 2 };
    const size = this.uint(offset + 2, 1);

    if (size < 1 || size > 4) throw new Error("CFF INDEX offset size");

    const offsets = Array.from({ length: count + 1 }, (_, index) =>
      this.uint(offset + 3 + index * size, size),
    );

    if (
      offsets[0] !== 1 ||
      offsets.some((value, index) => index > 0 && value < offsets[index - 1]!)
    )
      throw new Error("CFF INDEX offsets");
    const base = offset + 3 + (count + 1) * size - 1;

    const entries = offsets
      .slice(0, -1)
      .map((value, index) => this.range(base + value, offsets[index + 1]! - value));

    return { entries, end: base + offsets.at(-1)! };
  }
}

function numberAt(bytes: CffBytes, offset: number, dictionary: boolean) {
  const byte = bytes.uint(offset, 1);

  if (byte >= 32 && byte <= 246) return { value: byte - 139, end: offset + 1 };

  if (byte >= 247 && byte <= 250)
    return { value: (byte - 247) * 256 + bytes.uint(offset + 1, 1) + 108, end: offset + 2 };

  if (byte >= 251 && byte <= 254)
    return { value: -(byte - 251) * 256 - bytes.uint(offset + 1, 1) - 108, end: offset + 2 };

  if (byte === 28) return { value: bytes.range(offset + 1, 2).readInt16BE(), end: offset + 3 };

  if (byte === 29 && dictionary)
    return { value: bytes.range(offset + 1, 4).readInt32BE(), end: offset + 5 };

  if (byte === 255 && !dictionary)
    return { value: bytes.range(offset + 1, 4).readInt32BE() / 65536, end: offset + 5 };

  if (byte === 30 && dictionary) {
    let text = "";
    let end = offset + 1;

    for (let count = 0; count < 32; count += 1) {
      const pair = bytes.uint(end++, 1);

      for (const nibble of [pair >> 4, pair & 15]) {
        if (nibble === 15) {
          const value = Number(text);

          if (!Number.isFinite(value) || !text.length) throw new Error("CFF real number");

          return { value, end };
        }

        if (nibble === 13) throw new Error("CFF reserved real nibble");
        text += nibble < 10 ? String(nibble) : ([".", "e", "e-", "", "-"][nibble - 10] ?? "");
      }
    }

    throw new Error("CFF real length limit");
  }

  return null;
}

function dictionary(body: Buffer) {
  const bytes = new CffBytes(body);
  const entries = new Map<number, number[]>();
  let stack: number[] = [];
  let offset = 0;

  while (offset < body.length) {
    const number = numberAt(bytes, offset, true);

    if (number) {
      stack.push(number.value);
      offset = number.end;
    } else {
      let op = bytes.uint(offset++, 1);

      if (op === 12) op = 1200 + bytes.uint(offset++, 1);

      if (entries.has(op)) throw new Error("Duplicate CFF dictionary operator");
      entries.set(op, stack);
      stack = [];
    }

    if (stack.length > 48) throw new Error("CFF dictionary stack limit");
  }

  if (stack.length) throw new Error("Truncated CFF dictionary");

  return entries;
}

type CffWidthObservation = {
  width: number | null;
  reason: string;
  proof?: { operator: number; operands: number[]; nominalWidth: number; defaultWidth: number };
};

export function cffLiteralWidth(
  body: Buffer,
  defaultWidth: number,
  nominalWidth: number,
  local: Buffer[] = [],
  global: Buffer[] = [],
) {
  const stack: number[] = [];
  let steps = 0;
  const visits = new Set<string>();

  function prefix(program: Buffer, depth: number): CffWidthObservation {
    if (depth > 10) return { width: null, reason: "literal-prefix-subroutine-depth-limit" };
    const bytes = new CffBytes(program);
    let offset = 0;

    while (offset < program.length && ++steps <= 2048) {
      const number = numberAt(bytes, offset, false);

      if (number) {
        stack.push(number.value);
        offset = number.end;

        if (stack.length > 48) throw new Error("CFF prefix stack limit");
        continue;
      }

      const op = bytes.uint(offset++, 1);

      if ([1, 3, 18, 19, 20, 23, 4, 21, 22, 14].includes(op)) {
        const explicit =
          op === 21
            ? stack.length === 3
            : [4, 22].includes(op)
              ? stack.length === 2
              : op === 14
                ? [1, 5].includes(stack.length)
                : stack.length % 2 === 1;

        const count = stack.length - Number(explicit);

        if (
          (op === 21 && count !== 2) ||
          ([4, 22].includes(op) && count !== 1) ||
          (op === 14 && ![0, 4].includes(count))
        )
          throw new Error("Invalid first CFF width operand count");

        return {
          width: explicit ? nominalWidth + stack[0]! : defaultWidth,
          reason: explicit ? "literal-prefix-explicit-width" : "literal-prefix-default-width",
          proof: { operator: op, operands: [...stack], nominalWidth, defaultWidth },
        };
      }

      if (op === 11) return { width: null, reason: "literal-subroutine-return" };

      if ([10, 29].includes(op)) {
        const subrs = op === 10 ? local : global;
        const operand = stack.pop();
        const bias = subrs.length < 1240 ? 107 : subrs.length < 33900 ? 1131 : 32768;

        if (operand === undefined || !Number.isInteger(operand) || !subrs[operand + bias])
          throw new Error("CFF literal subroutine reference bounds");
        const key = `${op}:${operand + bias}`;

        if (visits.has(key)) return { width: null, reason: "cyclic-literal-prefix" };
        visits.add(key);
        const result = prefix(subrs[operand + bias]!, depth + 1);
        visits.delete(key);

        if (result.width !== null || result.reason !== "literal-subroutine-return") return result;
        continue;
      }

      return { width: null, reason: `unsupported-before-width-op-${op}` };
    }

    return { width: null, reason: steps > 2048 ? "literal-prefix-work-limit" : "no-width-command" };
  }

  return prefix(body, 0);
}

export function inspectCffWidths(body: Buffer, standardStrings: string[]) {
  const bytes = new CffBytes(body);

  if (bytes.uint(0, 1) !== 1 || bytes.uint(1, 1) !== 0 || bytes.uint(2, 1) < 4)
    throw new Error("Research supports CFF1 only");
  const names = bytes.index(bytes.uint(2, 1));
  const top = bytes.index(names.end);

  if (names.entries.length !== 1 || top.entries.length !== 1)
    throw new Error("Research supports one SID-keyed CFF face");
  const strings = bytes.index(top.end);
  const global = bytes.index(strings.end);
  const dict = dictionary(top.entries[0]!);

  if (dict.has(1230)) throw new Error("CID CFF outside bounded research");
  const matrix = dict.get(1207) ?? [0.001, 0, 0, 0.001, 0, 0];

  if (JSON.stringify(matrix) !== JSON.stringify([0.001, 0, 0, 0.001, 0, 0]))
    throw new Error("Non-default CFF FontMatrix outside bounded research");
  const charstrings = bytes.index(dict.get(17)?.[0] ?? -1);
  const privateInfo = dict.get(18);

  if (!privateInfo || privateInfo.length !== 2) throw new Error("CFF private dictionary required");
  const priv = dictionary(bytes.range(privateInfo[1]!, privateInfo[0]!));
  const defaultWidth = Math.floor(priv.get(20)?.[0] ?? 0);
  const nominalWidth = Math.floor(priv.get(21)?.[0] ?? 0);
  const localOffset = priv.get(19)?.[0];
  const local = localOffset === undefined ? [] : bytes.index(privateInfo[1]! + localOffset).entries;
  const charsetOffset = dict.get(15)?.[0] ?? 0;
  const sids = [0];
  let offset = charsetOffset;

  if (offset === 0) {
    if (charstrings.entries.length > 229) throw new Error("ISOAdobe charset length");

    for (let sid = 1; sid < charstrings.entries.length; sid += 1) sids.push(sid);
  } else {
    if (offset < 3) throw new Error("Expert charset outside bounded research");
    const format = bytes.uint(offset++, 1);

    if (format > 2) throw new Error("CFF charset format");

    while (sids.length < charstrings.entries.length) {
      const sid = bytes.uint(offset, 2);
      offset += 2;
      const count = format === 0 ? 0 : bytes.uint(offset, format);

      if (format) offset += format;

      if (sids.length + count + 1 > charstrings.entries.length || sid + count > 65535)
        throw new Error("CFF charset range");

      for (let index = 0; index <= count; index += 1) sids.push(sid + index);
    }
  }

  const glyphs = charstrings.entries.map((program, gid) => {
    const sid = sids[gid]!;
    const name = sid < 391 ? standardStrings[sid] : strings.entries[sid - 391]?.toString("ascii");

    if (!name) throw new Error("CFF glyph SID/string missing");

    return {
      gid,
      name,
      charStringOffset: program.byteOffset - body.byteOffset,
      charStringBytes: program.length,
      leadingBytes: program.subarray(0, 32).toString("hex"),
      ...cffLiteralWidth(program, defaultWidth, nominalWidth, local, global.entries),
    };
  });

  if (new Set(glyphs.map((glyph) => glyph.name)).size !== glyphs.length)
    throw new Error("Duplicate CFF glyph name");

  return { name: names.entries[0]!.toString("ascii"), defaultWidth, nominalWidth, matrix, glyphs };
}
