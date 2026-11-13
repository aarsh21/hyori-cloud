import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceOf, Query } from "@hyori-cloud/client-sdk/react";
import {
  generateRustContracts,
  parseRustContractManifest,
} from "../../scripts/generate-rust-contracts.ts";
import { rustBuildConfig } from "../../scripts/rust-build-config.ts";

export type ExistingResource = ResourceOf<Query["auth"]["status"]>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "hyori-sdk-evolution-"));
const compiler = path.join(root, "node_modules/typescript/bin/tsc");

try {
  const build = rustBuildConfig();

  const manifest = execFileSync(
    build.executable,
    [
      "run",
      "--offline",
      "--locked",
      "--quiet",
      "-p",
      "hyori-server",
      "--example",
      "contract_evolution",
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
      env: build.env,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );

  for (const [name, source] of Object.entries(
    generateRustContracts(parseRustContractManifest(manifest)),
  ))
    writeFileSync(path.join(temporary, name), source);

  symlinkSync(
    path.join(root, "packages/client-sdk/node_modules"),
    path.join(temporary, "node_modules"),
    "dir",
  );
  writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    path.join(temporary, "fixture-api.ts"),
    'export * from "./schemas";\nexport { operations, ApiRpc, type Api } from "./operations";\n',
  );
  writeFileSync(
    path.join(temporary, "fixture-client.ts"),
    'export * from "./schemas";\nexport { operations } from "./client-operations";\n',
  );
  writeFileSync(
    path.join(temporary, "fixture-wire.ts"),
    'export * from "./wire-schemas";\nexport { operations } from "./wire-operations";\n',
  );

  const consumer = `
    import { createClient } from "@hyori-cloud/client-sdk";
    import type { InputOf, OutputOf, ErrorOf } from "@hyori-cloud/client-sdk";
    import { createQuery } from "@hyori-cloud/client-sdk/react";
    import type { ResourceOf } from "@hyori-cloud/client-sdk/react";
    import { useQuery } from "@hyori-cloud/lib/query";
    const sdk = createClient();
    const query = createQuery(sdk);
    sdk.rpc.evolution.probe({ seed: 1 });
    export type Input = InputOf<typeof query.evolution.probe.getOptions>;
    export type Output = OutputOf<typeof query.evolution.probe>;
    export type Error = ErrorOf<typeof query.evolution.probe>;
    export function useProbe(input: Input): ResourceOf<typeof query.evolution.probe> {
      return useQuery(query.evolution.probe.getOptions(input));
    }
    export function complete(value: Output): string {
      switch (value.state) { case "ready": return String(value.revision); case "waiting": return "waiting"; }
      value.state satisfies never;
      return "";
    }
    // @ts-expect-error Rust input type is derived through the public SDK
    sdk.rpc.evolution.probe({ seed: "wrong" });
  `;

  writeFileSync(path.join(temporary, "consumer.ts"), consumer);
  writeFileSync(
    path.join(temporary, "tsconfig.json"),
    JSON.stringify({
      extends: path.join(root, "packages/client-sdk/tsconfig.json"),
      compilerOptions: {
        noUnusedLocals: false,
        noUnusedParameters: false,
        paths: {
          "@hyori-cloud/client-sdk": [path.join(root, "packages/client-sdk/src/index.ts")],
          "@hyori-cloud/client-sdk/react": [
            path.join(root, "packages/client-sdk/src/react/index.ts"),
          ],
          "@hyori-cloud/api/rpc": [path.join(temporary, "fixture-api.ts")],
          "@hyori-cloud/api/client": [path.join(temporary, "fixture-client.ts")],
          "@hyori-cloud/api/wire": [path.join(temporary, "fixture-wire.ts")],
        },
      },
      include: [path.join(temporary, "*.ts")],
      exclude: [],
    }),
  );

  const run = () =>
    Bun.spawnSync(["node", compiler, "--noEmit", "-p", path.join(temporary, "tsconfig.json")], {
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });

  const positive = run();

  if (positive.exitCode !== 0)
    throw new Error(
      `Evolved public SDK compile failed:\n${positive.stdout.toString()}${positive.stderr.toString()}`,
    );

  writeFileSync(
    path.join(temporary, "consumer.ts"),
    consumer.replace('case "waiting": return "waiting";', ""),
  );
  const negative = run();

  if (negative.exitCode === 0 || !negative.stdout.toString().includes("never"))
    throw new Error("The Rust-introduced state did not reject the incomplete public consumer.");

  writeFileSync(
    path.join(temporary, "consumer.ts"),
    consumer +
      `
    export function incompleteError(error: Extract<Error, { code: "fixture.old" | "fixture.new" }>): string {
      switch (error.code) { case "fixture.old": return error.message; }
      error.code satisfies never;
      return "";
    }
  `,
  );
  const errorVariant = run();

  if (errorVariant.exitCode === 0 || !errorVariant.stdout.toString().includes("never"))
    throw new Error("The Rust-introduced error variant did not reject its incomplete handler.");

  process.stdout.write(
    "PASS compiled Rust contract derives public RPC, Query options/resources and types; added Rust state/error variants reject incomplete consumers.\n",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
