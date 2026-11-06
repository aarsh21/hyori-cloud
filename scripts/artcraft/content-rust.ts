import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { readToolArchive, sha256 } from "./evidence-bytes.ts";

const [, , destination] = process.argv;

if (!destination || process.argv.length !== 3)
  throw new Error("Usage: bun scripts/artcraft/content-rust.ts NEW_OUTPUT");

const output = resolve(destination);

await mkdir(output);

const url = "https://static.rust-lang.org/dist/2026-10-15/rust-src-1.99.1.tar.gz";
const hash = "b0d6d3a7e46a97adfe6488f8b60c04c019566b8363eeb6ffb32c6cf63609071d";
const archive = await fetchBuildInput(url, hash, 64 * 1024 * 1024);
const members = readToolArchive(archive);
const prefix = "rust-src-1.99.1/rust-src/lib/rustlib/src/rust/";

const files: {
  member: string;
  sha256: string;
  bytes: number;
  copyright: string[];
  permission: string[];
}[] = [];

const evidence: { member: string; path: string; sha256: string; bytes: number }[] = [];
let index = 0;

for (const [member, bytes] of members) {
  if (!member.startsWith(prefix)) continue;
  const path = member.slice(prefix.length);

  if (!path.startsWith("library/")) continue;
  const text = bytes.toString("utf8");
  const lines = text.split("\n");
  const copyright = lines.filter((line) => /copyright|SPDX-FileCopyrightText/i.test(line));

  const permission = lines.filter((line) =>
    /SPDX-License-Identifier|Licensed under|Permission.*(?:use|copy|distribut)|All rights reserved|provided.*as.is|Apache.*LLVM|MIT AND/i.test(
      line,
    ),
  );

  files.push({ member: path, sha256: sha256(bytes), bytes: bytes.length, copyright, permission });
  const legal = /^(?:LICENSE|COPYRIGHT|NOTICE|CREDITS)(?:[._-]|$)/i.test(path.split("/").at(-1)!);

  const math =
    path.startsWith("library/compiler-builtins/") &&
    copyright.length > 0 &&
    /\.(?:rs|c|h|S)$/.test(path);

  if (legal || math) {
    const content = bytes; // Preserve the complete member, including multiline or non-leading clauses.
    const retained = `evidence-${index++}.txt`;
    await writeFile(join(output, retained), content, { flag: "wx" });
    evidence.push({ member: path, path: retained, sha256: sha256(content), bytes: content.length });
  }
}

if (!files.some((file) => file.member === "library/compiler-builtins/LICENSE.txt"))
  throw new Error("Compiler-builtins source component missing");

await writeFile(
  join(output, "source.json"),
  `${JSON.stringify({ schemaVersion: 1, url, sha256: hash, bytes: archive.length, rustCommit: "58cf8f9c35b355199727627d07ae34a4e2846d67", files, evidence, scope: "Exact source-component copyright/permission clauses; per-file math clauses retained in addition to whole licence texts; no target-linked-object completeness claim" }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(
  JSON.stringify(
    { sourceFiles: files.length, evidence: evidence.length, bytes: archive.length },
    null,
    2,
  ),
);
