import type { Plugin } from "vite";

const virtualId = "virtual:hyori-screen-assets";
const resolvedId = `\0${virtualId}`;

/** The client build runs first. Its real chunk graph supplies the SSR document's preload URLs. */
export function screenAssets(): Plugin {
  const assets: Record<string, string[]> = {};

  return {
    name: "hyori-screen-assets",
    sharedDuringBuild: true,
    resolveId(id) {
      if (id === virtualId) return resolvedId;
    },
    load(id) {
      if (id === resolvedId) return `export default ${JSON.stringify(assets)}`;
    },
    generateBundle(_options, bundle) {
      if (this.environment.name !== "client") return;

      for (const output of Object.values(bundle)) {
        if (output.type !== "chunk" || !output.facadeModuleId) continue;

        const name = output.facadeModuleId.match(
          /\/([^/]+-screen|signed-in-cloud|note-document)\.tsx$/,
        )?.[1];

        if (!name) continue;

        const visited = new Set<string>();

        function visit(file: string) {
          if (visited.has(file)) return;
          visited.add(file);
          const chunk = bundle[file];

          if (chunk?.type === "chunk") for (const dependency of chunk.imports) visit(dependency);
        }

        visit(output.fileName);
        assets[name] = [...visited].map((file) => `/${file}`);
      }
    },
  };
}
