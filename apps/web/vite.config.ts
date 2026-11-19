import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import { varlockVitePlugin } from "@varlock/vite-integration";
import babel from "@rolldown/plugin-babel";
import viteReact, { reactCompilerPreset } from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite-plus";
import { requestDisconnectBoundary } from "./tooling/request-disconnect.ts";
import { screenAssets } from "./tooling/screen-assets.ts";

export default defineConfig(({ command }) => ({
  server: {
    port: 3001,
  },
  resolve: {
    tsconfigPaths: true,
  },
  build: { manifest: true },
  // Keep the renderer, CommonJS hook shims and each workspace's icon version together.
  // A partially externalized intermediate build resolves them again from Nitro's directory,
  // producing duplicate React dispatchers or server/client icon mismatches on hydrated screens.
  environments:
    command === "build"
      ? {
          ssr: { resolve: { noExternal: true } },
          client: {
            build: {
              rolldownOptions: {
                output: {
                  // Compress the already-eager graph together; screens and closed dialogs stay lazy.
                  codeSplitting: {
                    groups: [
                      { name: "initial", tags: ["$initial"] },
                      {
                        // Automatic chunking leaves a long tail of one- and two-KB chunks shared
                        // between screens — single icons, hooks, dialog primitives — and each one
                        // is a request the first Files load pays for. Small modules that at least
                        // two chunks share merge into one chunk per set of importers instead, so
                        // each screen still loads only the code it uses. Larger modules stay where
                        // they are, so React, the menus and the file browser keep their own.
                        name: "shared",
                        minShareCount: 2,
                        maxModuleSize: 4096,
                        entriesAware: true,
                        entriesAwareMergeThreshold: 16384,
                      },
                    ],
                  },
                },
              },
            },
          },
        }
      : undefined,
  plugins: [
    varlockVitePlugin({ ssrInjectMode: "auto-load" }),
    tailwindcss(),
    tanstackStart(),
    nitro({ preset: "node-server", compressPublicAssets: true }),
    requestDisconnectBoundary(),
    screenAssets(),
    viteReact(),
    babel({ presets: [reactCompilerPreset()] }),
  ],
}));
