import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const manifestSchema = z.object({
  name: z.string(),
  version: z.string(),
  dependencies: z.record(z.string(), z.string()).default({}),
  optionalDependencies: z.record(z.string(), z.string()).default({}),
  peerDependencies: z.record(z.string(), z.string()).default({}),
  peerDependenciesMeta: z
    .record(z.string(), z.object({ optional: z.boolean().optional() }))
    .default({}),
  engines: z.object({ bun: z.string().optional() }).optional(),
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const fixtures = path.join(root, "tooling/architecture/artifact-fixtures");
const bun = process.execPath;
const environment = { PATH: process.env.PATH ?? "", BUN_CONFIG_NO_CLEAR_TERMINAL: "1" };

const ownedSources = new Map(
  ["client-sdk", "api", "lib"].map((name) => [
    `@hyori-cloud/${name}`,
    path.join(root, "packages", name),
  ]),
);

const archives = new Map<string, string>();

function manifest(directory: string) {
  return manifestSchema.parse(
    JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")),
  );
}

function run(command: string[], cwd: string) {
  const [executable, ...args] = command;

  if (!executable) throw new Error("Missing artifact check executable.");

  const result = spawnSync(executable, args, {
    cwd,
    env: environment,
    encoding: "utf8",
    timeout: 90_000,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error) throw result.error;

  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function pass(command: string[], cwd: string) {
  const result = run(command, cwd);

  if (result.status !== 0)
    throw new Error(`Artifact command failed: ${command.join(" ")}\n${result.output}`);

  return result.output;
}

function reject(command: string[], cwd: string, diagnostic: RegExp, label: string) {
  const result = run(command, cwd);

  if (result.status === null || result.status === 0 || !diagnostic.test(result.output))
    throw new Error(`${label} did not fail for the expected reason:\n${result.output}`);
  console.log(`PASS negative: ${label}`);
}

function installedPackage(name: string, from: string): string {
  let directory = from;

  while (true) {
    const candidate = path.join(directory, "node_modules", name);

    if (existsSync(path.join(candidate, "package.json"))) return realpathSync(candidate);
    const parent = path.dirname(directory);

    if (parent === directory) throw new Error(`Missing installed dependency ${name} from ${from}`);
    directory = parent;
  }
}

function assertPhysicalTree(directory: string, forbidFrameworks: boolean) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);

    if (entry.isSymbolicLink()) throw new Error(`Consumer contains a symlink: ${target}`);

    if (!realpathSync(target).startsWith(`${directory}${path.sep}`))
      throw new Error(`Consumer path escapes its physical parent: ${target}`);

    if (entry.name.startsWith(".env")) throw new Error(`Artifact includes an env file: ${target}`);

    if (entry.isDirectory()) assertPhysicalTree(target, forbidFrameworks);
    else if (entry.name === "package.json") {
      const value: unknown = JSON.parse(readFileSync(target, "utf8"));
      const named = z.object({ name: z.string().optional() }).safeParse(value);
      const name = named.success ? named.data.name : undefined;

      if (name === "@hyori-cloud/core")
        throw new Error("Retired legacy core artifact is present in the physical consumer tree.");

      if (
        forbidFrameworks &&
        name &&
        /^(?:react(?:-dom|-test-renderer|-native)?|@types\/react(?:-dom)?|lucide-react|next|@tanstack\/react-.*)$/.test(
          name,
        )
      )
        throw new Error(
          `Vanilla artifact consumer unexpectedly contains framework package ${name}`,
        );
    }
  }
}

function prepareConsumer(directory: string, withReact: boolean) {
  mkdirSync(directory);
  const modules = path.join(directory, "node_modules");
  mkdirSync(modules);
  const installed = new Map<string, { version: string; directory: string }>();

  function install(name: string, from: string, owner: string): string {
    const source = ownedSources.get(name) ?? installedPackage(name, from);
    const metadata = manifest(source);
    const previous = installed.get(name);

    if (previous?.version === metadata.version) return previous.directory;
    const target = path.join(previous ? path.join(owner, "node_modules") : modules, name);

    if (existsSync(target)) {
      if (manifest(target).version !== metadata.version)
        throw new Error(`Conflicting dependency at ${target}`);

      return target;
    }

    mkdirSync(path.dirname(target), { recursive: true });
    const archive = archives.get(name);

    if (name.startsWith("@hyori-cloud/") && !archive)
      throw new Error(`Owned dependency ${name} needs its own packed-artifact fixture.`);

    if (archive) {
      mkdirSync(target);
      pass(["tar", "-xzf", archive, "--strip-components=1", "-C", target], root);
      const packed = manifest(target);

      if (packed.engines?.bun !== "1.4.4")
        throw new Error(`${name} does not declare the supported consumer runtime.`);

      for (const version of Object.values(packed.dependencies)) {
        if (/^(?:workspace|catalog|file|link):/.test(version))
          throw new Error(`${name} tarball retains a workspace-only dependency: ${version}`);
      }
    } else {
      cpSync(source, target, {
        recursive: true,
        dereference: true,
        filter: (file) =>
          !["node_modules", ".git"].includes(path.relative(source, file).split(path.sep)[0] ?? ""),
      });
    }

    if (!previous) installed.set(name, { version: metadata.version, directory: target });
    const artifact = manifest(target);
    const dependencies = { ...artifact.dependencies };

    for (const [peer, version] of Object.entries(artifact.peerDependencies)) {
      if (!artifact.peerDependenciesMeta[peer]?.optional) dependencies[peer] = version;
    }

    for (const dependency of Object.keys(dependencies)) install(dependency, source, target);

    for (const dependency of Object.keys(artifact.optionalDependencies)) {
      // Optional platform dependencies are copied only when already present locally.
      let available = false;

      try {
        installedPackage(dependency, source);
        available = true;
      } catch {
        available = false;
      }

      if (available) install(dependency, source, target);
    }

    return target;
  }

  install("@hyori-cloud/client-sdk", root, directory);
  install("typescript", root, directory);
  install("@types/node", root, directory);
  const sdk = manifest(path.join(modules, "@hyori-cloud/client-sdk"));
  const peers: Record<string, string> = {};

  if (withReact) {
    for (const peer of ["react", "@types/react", "@tanstack/react-query"]) {
      if (!sdk.peerDependencies[peer] || !sdk.peerDependenciesMeta[peer]?.optional)
        throw new Error(`The SDK must declare ${peer} as an optional adapter peer.`);
      peers[peer] = manifest(install(peer, path.join(root, "packages/lib"), directory)).version;
    }
  }

  writeFileSync(
    path.join(directory, "package.json"),
    JSON.stringify({
      name: withReact ? "external-react-consumer" : "external-vanilla-consumer",
      private: true,
      type: "module",
      dependencies: { "@hyori-cloud/client-sdk": sdk.version, ...peers },
      devDependencies: {
        typescript: manifest(path.join(modules, "typescript")).version,
        "@types/node": manifest(path.join(modules, "@types/node")).version,
      },
    }),
  );
  writeFileSync(path.join(directory, "bunfig.toml"), 'env = false\n[install]\nauto = "disable"\n');
  writeFileSync(
    path.join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        target: "ESNext",
        module: "ESNext",
        moduleResolution: "Bundler",
        lib: ["ESNext", "DOM", "DOM.Iterable"],
        types: withReact ? ["node", "react"] : ["node"],
        jsx: "react-jsx",
        strict: true,
        noUncheckedIndexedAccess: true,
        noEmit: true,
        skipLibCheck: false,
        allowImportingTsExtensions: true,
        verbatimModuleSyntax: true,
      },
      include: ["consumer.ts"],
    }),
  );
  cpSync(
    path.join(fixtures, withReact ? "react.ts" : "vanilla.ts"),
    path.join(directory, "consumer.ts"),
  );
  assertPhysicalTree(directory, !withReact);

  return {
    directory,
    compiler: [
      bun,
      "--no-env-file",
      "--no-install",
      path.join(modules, "typescript/bin/tsc"),
      "-p",
      "tsconfig.json",
    ],
    runtime: [bun, "--no-env-file", "--no-install", "consumer.ts"],
  };
}

if (process.versions.bun !== "1.4.4")
  throw new Error("Run check:artifacts with the supported, pinned Bun 1.4.4.");

const temporary = mkdtempSync(path.join(tmpdir(), "hyori-packed-consumer-"));

try {
  if (temporary.startsWith(`${root}${path.sep}`))
    throw new Error("Artifact consumers must be outside the workspace.");
  let parent = path.dirname(temporary);

  while (true) {
    if (existsSync(path.join(parent, "node_modules")))
      throw new Error(`External consumer would inherit ancestor node_modules: ${parent}`);
    const next = path.dirname(parent);

    if (next === parent) break;
    parent = next;
  }

  for (const [name, source] of ownedSources) {
    const destination = path.join(temporary, "packs", name.split("/")[1]!);
    mkdirSync(destination, { recursive: true });
    pass(
      [bun, "--no-env-file", "pm", "pack", "--ignore-scripts", "--destination", destination],
      source,
    );
    const files = readdirSync(destination);

    if (files.length !== 1 || !files[0]?.endsWith(".tgz"))
      throw new Error(`Expected exactly one package tarball for ${name}.`);
    archives.set(name, path.join(destination, files[0]));
  }

  const vanilla = prepareConsumer(path.join(temporary, "vanilla"), false);
  pass(vanilla.compiler, vanilla.directory);
  console.log(pass(vanilla.runtime, vanilla.directory).trim());

  const files = pass([...vanilla.compiler, "--listFilesOnly"], vanilla.directory)
    .trim()
    .split("\n");

  for (const file of files) {
    if (!realpathSync(file.trim()).startsWith(`${vanilla.directory}${path.sep}`))
      throw new Error(`TypeScript resolved outside the external consumer: ${file}`);
  }

  console.log(
    `PASS vanilla typecheck without framework peers; all ${files.length} compiler inputs are external physical files`,
  );
  writeFileSync(
    path.join(vanilla.directory, "probe.ts"),
    'await import("@hyori-cloud/client-sdk/react");\n',
  );
  reject(
    [bun, "--no-env-file", "--no-install", "probe.ts"],
    vanilla.directory,
    /(?:Cannot find|could not resolve).*react/i,
    "React adapter import without its React peer",
  );
  const original = readFileSync(path.join(vanilla.directory, "consumer.ts"), "utf8");
  writeFileSync(
    path.join(vanilla.directory, "consumer.ts"),
    'import "@hyori-cloud/client-sdk/react";\n',
  );
  reject(
    vanilla.compiler,
    vanilla.directory,
    /Cannot find module '(?:react|@tanstack\/react-query)/,
    "React adapter types without declared peers",
  );
  writeFileSync(path.join(vanilla.directory, "consumer.ts"), original);
  writeFileSync(
    path.join(vanilla.directory, "probe.ts"),
    'await import("@hyori-cloud/client-sdk/src/client.ts");\n',
  );
  reject(
    [bun, "--no-env-file", "--no-install", "probe.ts"],
    vanilla.directory,
    /(?:Cannot find|not exported|could not resolve)/i,
    "private SDK source path blocked by the packed export map",
  );

  if (
    archives.size !== 3 ||
    existsSync(path.join(vanilla.directory, "node_modules/@hyori-cloud/core"))
  )
    throw new Error(
      "Packed consumers must contain exactly three owned artifacts and no legacy core.",
    );
  console.log("PASS vanilla SDK runtime and types resolve without any legacy backend artifact");

  const api = path.join(vanilla.directory, "node_modules/@hyori-cloud/api");
  const removedApi = path.join(temporary, "removed-api");
  renameSync(api, removedApi);

  try {
    reject(
      vanilla.runtime,
      vanilla.directory,
      /@hyori-cloud\/api/,
      "missing generated API artifact breaks runtime resolution",
    );
    reject(
      vanilla.compiler,
      vanilla.directory,
      /Cannot find module '@hyori-cloud\/api\/rpc'/,
      "missing generated API artifact breaks type resolution",
    );
  } finally {
    renameSync(removedApi, api);
  }

  const react = prepareConsumer(path.join(temporary, "react"), true);
  pass(react.compiler, react.directory);
  console.log(pass(react.runtime, react.directory).trim());
  console.log(
    "PASS offline packed-artifact acceptance: three real tarballs, no workspace mappings/symlinks, no package lifecycle scripts",
  );
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
