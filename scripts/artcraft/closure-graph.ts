import { z } from "zod";

export const cargoPackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  source: z.string().nullable(),
  manifest_path: z.string(),
  license: z.string().nullable(),
  license_file: z.string().nullable(),
  targets: z.array(z.object({ kind: z.array(z.string()), crate_types: z.array(z.string()) })),
});

export const cargoMetadataSchema = z.object({ packages: z.array(cargoPackageSchema) });

export type CargoPackage = z.infer<typeof cargoPackageSchema>;

export type TreePackage = { id: string; features: string[] };

export type TargetTree = { packages: TreePackage[]; edges: { from: string; to: string }[] };

// {p} includes source origins when necessary. Match those too: name+version alone does
// not identify a Cargo package when a registry release and patched Git crate coexist.
function matchPackage(display: string, packages: CargoPackage[]): CargoPackage {
  const match = display
    .replace(/ \(proc-macro\)$/, "")
    .match(/^([a-zA-Z0-9_-]+) v([^ ]+)(?: \((.+)\))?$/);

  if (!match) throw new Error(`Unsupported cargo tree package: ${display}`);

  const [, name, version, origin] = match;

  const candidates = packages.filter((pkg) => {
    if (pkg.name !== name || pkg.version !== version) return false;

    if (!origin) return pkg.source?.startsWith("registry+") ?? false;

    if (!pkg.source) return pkg.manifest_path === `${origin}/Cargo.toml`;

    if (!pkg.source.startsWith("git+")) return false;

    const hash = pkg.source.lastIndexOf("#");
    const shortSource = `${pkg.source.slice(4, hash)}#${pkg.source.slice(hash + 1, hash + 9)}`;

    return shortSource === origin;
  });

  if (candidates.length !== 1) throw new Error(`Ambiguous/missing cargo package: ${display}`);

  return candidates[0]!;
}

export function parseTargetTree(
  text: string,
  metadata: z.infer<typeof cargoMetadataSchema>,
): TargetTree {
  const packages = new Map<string, TreePackage>();
  const edges = new Map<string, { from: string; to: string }>();
  const parents: string[] = [];

  for (const line of text.trimEnd().split("\n")) {
    const [display, enabled, license, ...extra] = line.split("\\t");
    const match = display?.match(/^(\d+)(.+)$/);

    if (!match || enabled === undefined || license === undefined || extra.length)
      throw new Error(`Unexpected cargo tree line: ${line}`);

    const depth = Number(match[1]);
    const pkg = matchPackage(match[2]!, metadata.packages);
    const features = enabled ? enabled.split(",").sort() : [];
    const previous = packages.get(pkg.id);

    if (previous && previous.features.join(",") !== features.join(","))
      throw new Error(`Multiple feature units in tree: ${pkg.id}`);

    if (depth > parents.length) throw new Error("Cargo tree skipped a parent");

    if (depth === 0 && packages.size) throw new Error("Cargo tree has multiple roots");

    if (depth > 0) {
      const from = parents[depth - 1]!;
      edges.set(`${from}\n${pkg.id}`, { from, to: pkg.id });
    }

    packages.set(pkg.id, { id: pkg.id, features });
    parents[depth] = pkg.id;
    parents.length = depth + 1;
  }

  return {
    packages: [...packages.values()].sort((a, b) => a.id.localeCompare(b.id, "en")),
    edges: [...edges.values()].sort(
      (a, b) => a.from.localeCompare(b.from, "en") || a.to.localeCompare(b.to, "en"),
    ),
  };
}

export function assertNormalTargetTree(
  tree: TargetTree,
  metadata: z.infer<typeof cargoMetadataSchema>,
): void {
  if (!tree.packages.length) throw new Error("Missing target-normal closure");

  for (const unit of tree.packages) {
    const pkg = metadata.packages.find((candidate) => candidate.id === unit.id);

    if (!pkg || pkg.targets.some((target) => target.kind.includes("proc-macro")))
      throw new Error(`Host proc macro in target-normal closure: ${unit.id}`);
  }
}

// Host-inclusive tree features can legitimately have separate host/target units. This
// inventory retains package IDs only; never union its features into the normal target tree.
export function hostInclusiveIds(
  text: string,
  metadata: z.infer<typeof cargoMetadataSchema>,
): string[] {
  const ids = new Set<string>();

  for (const line of text.trimEnd().split("\n")) {
    const display = line.split("\\t")[0]?.replace(/^\d+/, "");

    if (!display) throw new Error("Missing host-inclusive package");

    ids.add(matchPackage(display, metadata.packages).id);
  }

  return [...ids].sort();
}
