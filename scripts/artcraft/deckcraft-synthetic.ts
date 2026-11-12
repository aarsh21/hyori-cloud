import { crc32 } from "node:zlib";
import { z } from "zod";
import { expandZipEntry, validateZipArchive } from "./validated-zip.ts";

/** Two tiny stored ZIP members; no user documents, fonts, samples or brand artwork. */
export function syntheticDeckCraft(): Buffer {
  const members = [
    { name: "mimetype", bytes: Buffer.from("application/vnd.storyteller.deckcraft+zip") },
    {
      name: "presentation.json",
      bytes: Buffer.from(
        JSON.stringify({
          format: "deckcraft",
          version: 1,
          generator: "Hyori synthetic host fixture",
          presentation: {},
        }),
      ),
    },
  ];

  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  for (const member of members) {
    const name = Buffer.from(member.name);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc32(member.bytes), 14);
    header.writeUInt32LE(member.bytes.length, 18);
    header.writeUInt32LE(member.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, member.bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc32(member.bytes), 16);
    directory.writeUInt32LE(member.bytes.length, 20);
    directory.writeUInt32LE(member.bytes.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += header.length + name.length + member.bytes.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(members.length, 8);
  end.writeUInt16LE(members.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, directory, end]);
}

export function inspectSyntheticOutput(bytes: Buffer) {
  const entries = validateZipArchive(bytes, null, {
    maxEntries: 100,
    maxExpandedBytes: 1024 * 1024,
    maxEntryBytes: 1024 * 1024,
  });

  const json = entries.find((entry) => entry.path === "presentation.json");

  if (!json) throw new Error("No native presentation manifest in editor output");

  return z
    .object({
      format: z.literal("deckcraft"),
      version: z.literal(1),
      presentation: z
        .object({ slides: z.array(z.object({ id: z.number() }).passthrough()).optional() })
        .passthrough(),
    })
    .parse(JSON.parse(expandZipEntry(json).toString()));
}
