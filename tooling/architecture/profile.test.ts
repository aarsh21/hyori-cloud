import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { ESLint } from "../fernando-lint/node_modules/eslint/lib/api.js";
import { createArchitectureConfig } from "../fernando-lint/index.js";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const base = "tooling/architecture/fixtures/";

const lint = new ESLint({
  cwd: rootDir,
  overrideConfigFile: true,
  overrideConfig: createArchitectureConfig({
    rootDir,
    tsconfig: "./tooling/architecture/tsconfig.fixtures.json",
    sourceRoles: {
      portableFeature: [`${base}feature-*.ts`, `${base}host-effect.ts`],
      hostAdapter: [`${base}host-effect.ts`],
      designSystem: [`${base}design-system-product.ts`],
      statePresenter: [`${base}presenter*.ts`],
      sdkReact: [],
    },
    productModules: ["@hyori-cloud/client-sdk"],
    discriminants: ["phase"],
  }),
});

for (const [file, rule] of [
  ["feature-effect.ts", "@fernando/architecture/no-feature-effects"],
  ["feature-transport.ts", "@fernando/architecture/no-feature-transport"],
  ["design-system-product.ts", "@fernando/architecture/design-system-purity"],
  ["presenter-incomplete.ts", "@typescript-eslint/switch-exhaustiveness-check"],
]) {
  test(`Hyori actual owned origins reject ${file}`, async () => {
    const [result] = await lint.lintFiles(`${base}${file}`);
    assert.ok(result, `Expected a lint result for ${file}`);
    assert.ok(
      result.messages.some((message) => message.ruleId === rule),
      JSON.stringify(result.messages),
    );
  });
}

for (const file of ["host-effect.ts", "presenter.ts"]) {
  test(`Hyori explicit valid boundary accepts ${file}`, async () => {
    const [result] = await lint.lintFiles(`${base}${file}`);
    assert.ok(result, `Expected a lint result for ${file}`);
    assert.equal(result.errorCount, 0, JSON.stringify(result.messages));
  });
}
