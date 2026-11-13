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
                  codeSplitting: { groups: [{ name: "initial", tags: ["$initial"] }] },
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
