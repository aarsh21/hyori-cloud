import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { z } from "zod";

const packageManifest = z.object({
  name: z.string(),
  exports: z.record(z.string(), z.json()).optional(),
  dependencies: z.record(z.string(), z.string()).optional(),
  peerDependencies: z.record(z.string(), z.string()).optional(),
  devDependencies: z.record(z.string(), z.string()).optional(),
});

type Manifest = z.infer<typeof packageManifest> & { directory: string };

type Reference = { specifier: string; typeOnly: boolean; line: number };

const root = fileURLToPath(new URL("../../", import.meta.url));
const manifests = new Map<string, Manifest>();

for (const directory of readdirSync(path.join(root, "packages"), { withFileTypes: true })) {
  const manifestPath = path.join(root, "packages", directory.name, "package.json");

  if (!directory.isDirectory() || !existsSync(manifestPath)) continue;
  const manifest = packageManifest.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  manifests.set(manifest.name, { ...manifest, directory: path.dirname(manifestPath) });
}

const errors: string[] = [];
const files: string[] = [];

function walk(directory: string) {
  if (!existsSync(directory)) return;

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (["node_modules", "dist", ".output", ".tanstack"].includes(entry.name)) continue;
    const target = path.join(directory, entry.name);

    if (entry.isDirectory()) walk(target);
    else if (/\.(?:tsx?|mjs)$/.test(entry.name) && !entry.name.endsWith(".gen.ts"))
      files.push(target);
  }
}

walk(path.join(root, "packages"));

walk(path.join(root, "apps/web/src"));

const compilerOptions = {
  moduleResolution: ts.ModuleResolutionKind.Bundler,
  module: ts.ModuleKind.ESNext,
  target: ts.ScriptTarget.ESNext,
  jsx: ts.JsxEmit.ReactJSX,
} satisfies ts.CompilerOptions;

function references(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const found: Reference[] = [];

  function visit(node: ts.Node) {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      found.push({
        specifier: node.moduleSpecifier.text,
        typeOnly: ts.isImportDeclaration(node) ? !!node.importClause?.isTypeOnly : node.isTypeOnly,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    }

    if (
      ts.isCallExpression(node) &&
      (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === "require")) &&
      node.arguments[0] &&
      ts.isStringLiteral(node.arguments[0])
    )
      found.push({
        specifier: node.arguments[0].text,
        typeOnly: false,
        line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
      });
    ts.forEachChild(node, visit);
  }

  visit(source);

  return found;
}

function error(file: string, line: number, message: string) {
  errors.push(`${path.relative(root, file)}:${line}: ${message}`);
}

for (const file of files) {
  const local = path.relative(root, file).replaceAll("\\", "/");

  for (const reference of references(file)) {
    const specifier = reference.specifier;

    if (specifier === "next-themes" && local !== "packages/ui/src/theme.tsx")
      error(
        file,
        reference.line,
        "Appearance vendor imports belong to the owned UI theme adapter.",
      );

    const owner = [...manifests.values()].find((manifest) =>
      file.startsWith(`${manifest.directory}${path.sep}`),
    );

    if (specifier.startsWith("@hyori-cloud/")) {
      const [scope, name, ...rest] = specifier.split("/");
      const manifest = manifests.get(`${scope}/${name}`);
      const subpath = rest.length ? `./${rest.join("/")}` : ".";

      if (
        !manifest ||
        (!(subpath in (manifest.exports ?? {})) &&
          !Object.keys(manifest.exports ?? {}).some(
            (key) => key.includes("*") && subpath.startsWith(key.slice(0, key.indexOf("*"))),
          ))
      )
        error(file, reference.line, `Not a declared public package entry: ${specifier}`);

      if (
        owner &&
        owner.name !== manifest?.name &&
        ![owner.dependencies, owner.peerDependencies, owner.devDependencies].some(
          (dependencies) => manifest && dependencies?.[manifest.name],
        )
      )
        error(file, reference.line, `Undeclared owned dependency: ${specifier}`);
    }

    const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule
      ?.resolvedFileName;

    if (resolved && local.startsWith("packages/") && resolved.startsWith(path.join(root, "apps")))
      error(file, reference.line, "Packages cannot reach back into apps.");

    if (
      resolved &&
      owner &&
      resolved.startsWith(path.join(root, "packages")) &&
      !resolved.startsWith(`${owner.directory}${path.sep}`) &&
      !specifier.startsWith("@hyori-cloud/")
    )
      error(file, reference.line, "Cross-package private path/alias bypasses public exports.");

    if (
      local.startsWith("packages/features/src/") &&
      !/\.(test|spec)\.[cm]?tsx?$/.test(local) &&
      !specifier.startsWith("@hyori-cloud/") &&
      !specifier.startsWith("#") &&
      !specifier.startsWith(".") &&
      !specifier.startsWith("react/jsx-runtime")
    )
      error(
        file,
        reference.line,
        `Portable features must consume an owned facade, not ${specifier}.`,
      );
  }
}

function visitRootGraph(start: string, label: string) {
  const visited = new Set<string>();

  function visit(file: string) {
    if (visited.has(file)) return;
    visited.add(file);

    for (const reference of references(file)) {
      const specifier = reference.specifier;

      if (
        /^(react(?:\/|$)|react-dom(?:\/|$)|next(?:\/|$)|@tanstack\/react-query(?:\/|$))/.test(
          specifier,
        ) ||
        /^@hyori-cloud\/lib\/(react|query|icons)$/.test(specifier) ||
        /^@hyori-cloud\/client-sdk\/react$/.test(specifier)
      )
        error(
          file,
          reference.line,
          `${label} root runtime/declarations reach optional React or host adapter ${specifier}.`,
        );

      const resolved = ts.resolveModuleName(specifier, file, compilerOptions, ts.sys).resolvedModule
        ?.resolvedFileName;

      if (resolved?.startsWith(path.join(root, "packages")) && /\.(tsx?|mjs)$/.test(resolved)) {
        if (/\/(?:service|db|server)\.[cm]?tsx?$/.test(resolved))
          error(file, reference.line, `${label} client graph reaches server implementation.`);
        visit(resolved);
      }
    }
  }

  visit(start);
  process.stdout.write(
    `Checked ${label} graph: ${visited.size} owned modules (runtime and declaration edges).\n`,
  );
}

visitRootGraph(path.join(root, "packages/client-sdk/src/index.ts"), "vanilla SDK");

visitRootGraph(path.join(root, "packages/api/src/rpc.ts"), "client-safe RPC");

if (errors.length) {
  process.stderr.write(`${[...new Set(errors)].join("\n")}\n`);
  process.exitCode = 1;
} else
  process.stdout.write(`Public package boundaries passed across ${files.length} source files.\n`);
