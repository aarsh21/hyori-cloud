import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ResourceOf, Query } from "@hyori-cloud/client-sdk/react";

export type ExistingResource = ResourceOf<Query["auth"]["status"]>;

const root = fileURLToPath(new URL("../../", import.meta.url));
const temporary = mkdtempSync(path.join(tmpdir(), "hyori-sdk-evolution-"));
const compiler = path.join(root, "node_modules/typescript/bin/tsc");

try {
  symlinkSync(
    path.join(root, "packages/client-sdk/node_modules"),
    path.join(temporary, "node_modules"),
    "dir",
  );
  writeFileSync(path.join(temporary, "package.json"), JSON.stringify({ type: "module" }));
  writeFileSync(
    path.join(temporary, "fixture-api.ts"),
    `
    export * from "@hyori-cloud/core/rpc";
    import { operations as original } from "@hyori-cloud/core/rpc";
    import { Rpc } from "@hyori-cloud/lib/effect/rpc";
    import { Schema } from "@hyori-cloud/lib/effect";
    export const operations = [...original, {
      rpc: Rpc.make("evolution.probe", {
        payload: Schema.Struct({ seed: Schema.Number }),
        success: Schema.Struct({ revision: Schema.Number, state: Schema.Literal("ready", "waiting") }),
        error: Schema.Struct({ code: Schema.Literal("fixture.old", "fixture.new"), message: Schema.String }),
      }), kind: "query",
    }, {
      rpc: Rpc.make("evolution.noInput", { payload: Schema.Void, success: Schema.String }), kind: "query",
    }, {
      rpc: Rpc.make("evolution.optional", { payload: Schema.UndefinedOr(Schema.Struct({ value: Schema.String })), success: Schema.String }), kind: "query",
    }] as const;
  `,
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
    sdk.rpc.evolution.noInput();
    query.evolution.noInput.getOptions();
    sdk.rpc.evolution.optional();
    query.evolution.optional.getOptions();
    query.evolution.optional.getOptions({ value: "optional" });
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
          "@hyori-cloud/core/rpc": [path.join(root, "packages/core/src/rpc.ts")],
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
    throw new Error("The newly introduced state did not reject the incomplete public consumer.");
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
    throw new Error("The added error variant did not reject its incomplete handler.");
  process.stdout.write(
    "PASS declaration-only operation automatically derives RPC, query, options, resources, and public types; new state/error variants reject incomplete consumers.\n",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
