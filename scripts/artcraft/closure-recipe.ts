import { z } from "zod";

const trunkSchema = z.object({
  build: z.object({
    features: z.never().optional(),
    all_features: z.never().optional(),
    no_default_features: z.never().optional(),
  }),
  hooks: z.never().optional(),
});

// This is intentionally an allowlist for these four reviewed tagged recipes, not a
// shell/YAML interpreter. Changed commands or feature controls require a fresh decision.
export function declaredWebRecipe(app: string, files: Map<string, Buffer>) {
  const required = (path: string): string => {
    const bytes = files.get(path);

    if (!bytes) throw new Error(`Missing tagged build recipe: ${path}`);

    return bytes.toString("utf8");
  };

  const command =
    app === "gridcraft"
      ? 'trunk build --release --dist "$SITE" --public-url ./'
      : "trunk build --release";

  const script = required("packaging/web/package.sh");
  const occurrences = [...script.matchAll(/&& (trunk build[^\n)]+)/g)].map((match) => match[1]);

  if (occurrences.length !== 1 || occurrences[0] !== command)
    throw new Error(`Unreviewed tagged web command: ${app}`);

  trunkSchema.parse(Bun.TOML.parse(required(`apps/${app}-web/Trunk.toml`)));
  const html = required(`apps/${app}-web/index.html`);
  const links = [...html.matchAll(/<link\b[^>]*\bdata-trunk\b[^>]*\brel="rust"[^>]*>/g)];

  if (
    links.length !== 1 ||
    /data-(?:cargo-)?(?:features|all-features|no-default-features)/.test(links[0]![0])
  )
    throw new Error(`Unreviewed Trunk Rust feature selector: ${app}`);

  const binary = links[0]![0].match(/data-bin="([^"]+)"/)?.[1];

  if (binary && binary !== `${app}-web`) throw new Error(`Unexpected Trunk binary: ${binary}`);

  const wrapper = required(app === "deckcraft" ? "packaging/common.sh" : "packaging/env.sh");

  if (/RUSTFLAGS|CARGO_BUILD_TARGET|CARGO_\w*FEATURE/.test(wrapper))
    throw new Error(`Unreviewed packaging feature/target environment: ${app}`);

  const release = required(".github/workflows/release.yml");

  if (!release.includes("uses: storytold/craft-common-actions/.github/workflows/release.yml@main"))
    throw new Error(`Unreviewed release workflow: ${app}`);

  const webCraftFonts = /\bweb-craft-fonts:\s*true\b/.test(release);

  if (webCraftFonts !== (app === "wordcraft"))
    throw new Error(`Unreviewed web font environment: ${app}`);

  return {
    command,
    directory: `apps/${app}-web`,
    target: "wasm32-unknown-unknown",
    defaultFeatures: true,
    additionalFeatures: [],
    webCraftFonts,
    releaseUsesLockedFlag: false,
    evidenceStatus: "tagged-recipe-and-successful-run-reference; no-release-link-attestation",
  };
}
