import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import config from "../../vite.config.ts";
import genericPlugin from "./src/index.ts";
import effectPlugin from "./src/effect/index.ts";

const root = fileURLToPath(new URL("../../", import.meta.url));
const packageVersion = z.object({ version: z.string() });

const lintOutput = z.object({
  diagnostics: z.array(z.object({ code: z.string() })),
});

test("Oxlint and plugin runtime stay exactly matched to Vite+", () => {
  const oxlint = packageVersion.parse(
    JSON.parse(readFileSync(new URL(import.meta.resolve("oxlint/package.json")), "utf8")),
  );

  const plugins = packageVersion.parse(
    JSON.parse(
      readFileSync(new URL("./package.json", import.meta.resolve("@oxlint/plugins")), "utf8"),
    ),
  );

  const vitePlus = z
    .object({
      dependencies: z.object({ oxlint: z.string(), "@oxlint/plugins": z.string() }),
    })
    .parse(
      JSON.parse(readFileSync(new URL(import.meta.resolve("vite-plus/package.json")), "utf8")),
    );

  const manifest = z
    .object({
      devDependencies: z.object({ oxlint: z.string(), "@oxlint/plugins": z.string() }),
    })
    .parse(JSON.parse(readFileSync(join(root, "package.json"), "utf8")));

  assert.equal(oxlint.version, plugins.version);
  assert.equal(manifest.devDependencies.oxlint, oxlint.version);
  assert.equal(manifest.devDependencies["@oxlint/plugins"], oxlint.version);
  assert.equal(vitePlus.dependencies.oxlint, `=${oxlint.version}`);
  assert.equal(vitePlus.dependencies["@oxlint/plugins"], `=${oxlint.version}`);
});

test("all vendored generic and Effect rules remain enabled as errors", () => {
  assert.ok(config.lint);
  assert.ok(config.lint.rules);

  for (const [namespace, plugin] of [
    ["anti-slop", genericPlugin],
    ["anti-slop-effect", effectPlugin],
  ] as const) {
    for (const name of Object.keys(plugin.rules)) {
      assert.equal(config.lint.rules[`${namespace}/${name}`], "error", `${namespace}/${name}`);
    }
  }

  assert.equal(config.lint.rules["oxc/no-accumulating-spread"], "error");
});

test("the actual Vite+ config rejects generic and Effect probes and accepts clean code", () => {
  const probeRoot = mkdtempSync(join(tmpdir(), "hyori-anti-slop-"));
  const rejectedFile = join(probeRoot, "rejected.ts");
  const acceptedFile = join(probeRoot, "accepted.ts");
  const vp = fileURLToPath(new URL("./bin/vp", import.meta.resolve("vite-plus/package.json")));

  function lint(file: string) {
    return spawnSync(process.execPath, [vp, "lint", "--no-ignore", "--format=json", file], {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  }

  try {
    writeFileSync(
      rejectedFile,
      "const source = [1, 2];\nexport const result = { _tag: 'Ready', values: source.filter(x => x > 0).map(x => x + 1) };\n",
    );
    writeFileSync(acceptedFile, "export const one = 1;\nexport const two = 2;\n");
    const rejected = lint(rejectedFile);
    assert.equal(
      rejected.status,
      1,
      `${rejected.error ?? ""}\n${rejected.stdout}\n${rejected.stderr}`,
    );
    const diagnostics = lintOutput.parse(JSON.parse(rejected.stdout)).diagnostics;
    assert.ok(diagnostics.some(({ code }) => code === "anti-slop(no-array-filter-map)"));
    assert.ok(
      diagnostics.some(({ code }) => code === "anti-slop-effect(no-manual-tagged-construction)"),
    );
    const accepted = lint(acceptedFile);
    assert.equal(
      accepted.status,
      0,
      `${accepted.error ?? ""}\n${accepted.stdout}\n${accepted.stderr}`,
    );
    assert.deepEqual(lintOutput.parse(JSON.parse(accepted.stdout)).diagnostics, []);
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
});
