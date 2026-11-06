import { mkdtemp, mkdir, open, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import pins from "../../tooling/artcraft/builds/deckcraft-host-v1/tool-pins.json" with { type: "json" };
import { readToolArchive, sha256 } from "./evidence-bytes.ts";

export async function fetchBuildInput(
  url: string,
  expectedSha256?: string,
  maximumBytes = 256 * 1024 * 1024,
): Promise<Buffer> {
  const staging = await mkdtemp(join(tmpdir(), "hyori-deck-input-"));

  try {
    const response = await fetch(url, {
      credentials: "omit",
      signal: AbortSignal.timeout(120_000),
    });

    if (!response.ok || !response.body)
      throw new Error(`Build input HTTP ${response.status}: ${url}`);

    const file = await open(join(staging, "input"), "wx");
    const reader = response.body.getReader();
    let size = 0;

    try {
      for (;;) {
        const chunk = await reader.read();

        if (chunk.done) break;

        size += chunk.value.byteLength;

        if (size > maximumBytes) throw new Error(`Build input exceeds bound: ${url}`);

        await file.writeFile(chunk.value);
      }
    } finally {
      await reader.cancel();
      await file.close();
    }

    const bytes = await readFile(join(staging, "input"));

    if (expectedSha256 && sha256(bytes) !== expectedSha256)
      throw new Error(`Build input checksum mismatch: ${url}`);

    return bytes;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function acquireDeckTools(destination: string, bunBinary: string): Promise<string> {
  const output = resolve(destination);
  await mkdir(output); // Exclusive destination; never reuse an extracted upstream directory.

  const records: {
    id: string;
    url: string;
    bytes: number;
    sha256: string;
    members: { source: string; output: string; sha256: string }[];
  }[] = [];

  async function retain(path: string, bytes: Buffer, executable = false) {
    const target = join(output, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: "wx" });

    if (executable) await chmod(target, 0o755);
  }

  for (const archive of pins.archives) {
    if (archive.checksumUrl) {
      const checksum = await fetchBuildInput(archive.checksumUrl, undefined, 4096);

      if (checksum.toString().trim().split(/\s+/)[0] !== archive.sha256)
        throw new Error(`Publisher checksum changed: ${archive.id}`);

      await retain(`evidence/${archive.id}.sha256`, checksum);
    }

    const bytes = await fetchBuildInput(archive.url, archive.sha256);
    const entries = readToolArchive(bytes); // Validate every member before writing any file.
    const members: { source: string; output: string; sha256: string }[] = [];

    for (const [path, content] of entries) {
      let target: string | null = null;
      let executable = false;

      if (archive.id === "rust-std") {
        const prefix = "rust-std-1.99.1-wasm32-unknown-unknown/rust-std-wasm32-unknown-unknown/";

        if (path.startsWith(`${prefix}lib/rustlib/wasm32-unknown-unknown/`))
          target = `wasm-sysroot/${path.slice(prefix.length)}`;
      } else if (path.split("/").at(-1) === (archive.id === "binaryen" ? "wasm-opt" : archive.id)) {
        target = `bin/${archive.id === "binaryen" ? "wasm-opt" : archive.id}`;
        executable = true;
      } else if (archive.id === "binaryen" && path.includes("/lib/")) {
        target = `binaryen-lib/${path.slice(path.indexOf("/lib/") + 5)}`;
      }

      if (/^(?:LICENSE|COPYRIGHT|NOTICE|AUTHORS|COPYING)(?:[._-]|$)/i.test(path.split("/").at(-1)!))
        target = `legal/${archive.id}/${path}`;

      if (target) {
        await retain(target, content, executable);
        members.push({ source: path, output: target, sha256: sha256(content) });
      }
    }

    if (
      !members.some((member) =>
        archive.id === "rust-std"
          ? member.output.startsWith("wasm-sysroot/")
          : member.output === `bin/${archive.id === "binaryen" ? "wasm-opt" : archive.id}`,
      )
    )
      throw new Error(`Pinned tool payload missing: ${archive.id}`);

    records.push({
      id: archive.id,
      url: archive.url,
      bytes: bytes.length,
      sha256: sha256(bytes),
      members,
    });
  }

  const bun = await readFile(bunBinary);

  if (bun.length !== pins.bun.bytes || sha256(bun) !== pins.bun.sha256)
    throw new Error("Pinned Bun binary mismatch");

  await retain("bin/bun", bun, true);
  const path = join(output, "tool-inputs.json");
  await writeFile(
    path,
    `${JSON.stringify({ schemaVersion: 1, baseImage: pins.baseImage, archives: records, bun: pins.bun, hostExecutionOfDownloadedTools: false }, null, 2)}\n`,
    { flag: "wx" },
  );

  return path;
}

if (import.meta.main) {
  const [, , output, bunBinary] = process.argv;

  if (!output || !bunBinary || process.argv.length !== 4)
    throw new Error("Usage: bun scripts/artcraft/deckcraft-tools.ts NEW_OUTPUT PINNED_BUN_BINARY");

  console.log(await acquireDeckTools(output, bunBinary));
}
