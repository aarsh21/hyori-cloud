import { mkdir, writeFile, readFile } from "node:fs/promises";
import { join, posix, resolve } from "node:path";
import { z } from "zod";
import { fetchBuildInput } from "./deckcraft-tools.ts";
import { sha256, readGitSourceArchive } from "./evidence-bytes.ts";
import { readClosureManifest } from "./closure.ts";
import { sfntAt } from "./content-binary.ts";

const [, , destination, configPath] = process.argv;

if (!destination || !configPath || process.argv.length !== 4)
  throw new Error("Usage: bun scripts/artcraft/content-fetch.ts NEW_OUTPUT PUBLIC_INPUT_CONFIG");

const config = z
  .object({
    editors: z
      .array(
        z.object({
          app: z.enum(["wordcraft", "gridcraft", "deckcraft", "pdfcraft"]),
          sourceArchive: z.string(),
        }),
      )
      .length(4),
  })
  .parse(JSON.parse(await readFile(configPath, "utf8")));

const closure = await readClosureManifest();
const output = resolve(destination);

await mkdir(output);

const files: { id: string; path: string; url: string; bytes: number; sha256: string }[] = [];
const failures: { id: string; url: string; error: string }[] = [];

async function retain(id: string, url: string) {
  try {
    const bytes = await fetchBuildInput(url, undefined, 8 * 1024 * 1024);
    const path = `${id}.source`;
    await writeFile(join(output, path), bytes, { flag: "wx" });
    files.push({ id, path, url, bytes: bytes.length, sha256: sha256(bytes) });

    return bytes;
  } catch (error) {
    failures.push({ id, url, error: String(error) });

    return null;
  }
}

const rust = "58cf8f9c35b355199727627d07ae34a4e2846d67";

for (const path of [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "COPYRIGHT",
  "license-metadata.json",
  "REUSE.toml",
  ".gitmodules",
  "library/Cargo.toml",
  "library/Cargo.lock",
  "library/compiler-builtins/Cargo.toml",
  "library/core/src/unicode/unicode_data.rs",
])
  await retain(
    `rust-${path.replaceAll("/", "_")}`,
    `https://raw.githubusercontent.com/rust-lang/rust/${rust}/${path}`,
  );

for (const path of [
  "COPYRIGHT-library.html",
  "licenses/Unicode-3.0.txt",
  "licenses/LLVM-exception.txt",
])
  await retain(
    `rust-release-${path.replaceAll("/", "_")}`,
    `https://doc.rust-lang.org/1.99.1/${path}`,
  );

const bindgen = "165586f854c852bcbc4d14d8a75a0a0e0d0abc12";

for (const path of [
  "LICENSE-MIT",
  "LICENSE-APACHE",
  "crates/cli-support/src/js/mod.rs",
  "crates/cli-support/src/js/binding.rs",
  "Cargo.lock",
])
  await retain(
    `wasm-bindgen-${path.replaceAll("/", "_")}`,
    `https://raw.githubusercontent.com/wasm-bindgen/wasm-bindgen/${bindgen}/${path}`,
  );

async function tagCommit(repo: string, tag: string) {
  const body = await retain(
    `${repo.split("/")[1]}-tag-ref`,
    `https://api.github.com/repos/${repo}/git/ref/tags/${tag}`,
  );

  if (!body) return null;

  const object = z
    .object({
      object: z.object({
        type: z.enum(["tag", "commit"]),
        sha: z.string().regex(/^[a-f0-9]{40}$/),
      }),
    })
    .parse(JSON.parse(body.toString())).object;

  if (object.type === "commit") return object.sha;

  const tagBody = await retain(
    `${repo.split("/")[1]}-tag-object`,
    `https://api.github.com/repos/${repo}/git/tags/${object.sha}`,
  );

  if (!tagBody) return null;

  return z
    .object({
      object: z.object({ type: z.literal("commit"), sha: z.string().regex(/^[a-f0-9]{40}$/) }),
    })
    .parse(JSON.parse(tagBody.toString())).object.sha;
}

for (const recipe of [
  {
    repo: "trunk-rs/trunk",
    tag: "v0.21.14",
    paths: [
      "LICENSE-MIT",
      "LICENSE-APACHE",
      "src/pipelines/rust/mod.rs",
      "src/pipelines/rust/bindgen.rs",
      "src/pipelines/html.rs",
    ],
  },
  {
    repo: "WebAssembly/binaryen",
    tag: "version_123",
    paths: ["LICENSE", "src/tools/wasm-opt.cpp", "src/passes/Asyncify.cpp"],
  },
]) {
  const commit = await tagCommit(recipe.repo, recipe.tag);

  if (commit)
    for (const path of recipe.paths)
      await retain(
        `${recipe.repo.split("/")[1]}-${path.replaceAll("/", "_")}`,
        `https://raw.githubusercontent.com/${recipe.repo}/${commit}/${path}`,
      );
}

const fontCommit = "b076417b5880bd4154bd22f00695b1d28c6bea83";

for (const path of ["ATTRIBUTION.md", "fonts/manifest.txt"])
  await retain(
    `craft-fonts-${path.replaceAll("/", "_")}`,
    `https://raw.githubusercontent.com/storytold/craft-fonts/${fontCommit}/${path}`,
  );

const fontManifest = files.find((file) => file.id === "craft-fonts-fonts_manifest.txt");

if (fontManifest)
  for (const line of (await readFile(join(output, fontManifest.path), "utf8")).split("\n")) {
    if (line.startsWith("#") || !line.includes("Geor")) continue;
    const path = line.split(" | ")[2]?.trim();

    if (!path || path.split("/").some((part) => !part || part === ".." || part === "."))
      throw new Error("Invalid pinned font manifest path");

    const font = await retain(
      "craft-fonts-georgian-font",
      `https://raw.githubusercontent.com/storytold/craft-fonts/${fontCommit}/${path.split("/").map(encodeURIComponent).join("/")}`,
    );

    if (font)
      await writeFile(
        join(output, "georgian-font-metadata.json"),
        JSON.stringify(sfntAt(font, 0), null, 2),
        { flag: "wx" },
      );
    await retain(
      "craft-fonts-georgian-OFL",
      `https://raw.githubusercontent.com/storytold/craft-fonts/${fontCommit}/${posix.dirname(path)}/OFL.txt`,
    );
  }

for (const entry of config.editors) {
  const app = entry.app;

  try {
    const source = closure.sources.find((source) => source.id === `${app}-source`)!;
    const archive = await readFile(entry.sourceArchive);

    if (sha256(archive) !== source.sha256) throw new Error("Tagged source checksum mismatch");
    const tree = readGitSourceArchive(archive, source.root!, source.commit!);
    const commit = tree.get("craft-i18n.rev")?.toString().trim() ?? "";

    if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid catalog pin");

    for (const path of ["LICENSE-MIT", "LICENSE-APACHE", "NOTICE", "ATTRIBUTION.md"])
      await retain(
        `${app}-craft-i18n-${path}`,
        `https://raw.githubusercontent.com/storytold/craft-i18n/${commit}/${path}`,
      );
  } catch (error) {
    failures.push({
      id: `${app}-i18n-pin`,
      url: "tagged editor craft-i18n.rev",
      error: String(error),
    });
  }
}

for (const path of ["profiles/ProPhoto-v2-micro.icc", "license"])
  await retain(
    `compact-icc-${posix.basename(path)}`,
    `https://raw.githubusercontent.com/saucecontrol/Compact-ICC-Profiles/bdd84663061bc4ae95ca70decff54f581e27f702/${path}`,
  );

await writeFile(
  join(output, "sources.json"),
  `${JSON.stringify({ schemaVersion: 1, trust: "Publisher TLS/version/ref observations and SHA-256 pins; no signature or legal approval claimed", files, failures }, null, 2)}\n`,
  { flag: "wx" },
);

console.log(JSON.stringify({ files: files.length, failures }, null, 2));
