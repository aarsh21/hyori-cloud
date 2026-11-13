import { fileURLToPath } from "node:url";
import { createArchitectureConfig } from "../fernando-lint/index.js";
import reactHooks from "eslint-plugin-react-hooks";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

const profile = createArchitectureConfig({
  rootDir,
  tsconfig: "./tooling/architecture/tsconfig.json",
  sourceRoles: {
    portableFeature: ["packages/features/src/**/*.{ts,tsx}"],
    designSystem: ["packages/ui/src/**/*.{ts,tsx}"],
    sdkReact: ["packages/client-sdk/src/react/**/*.{ts,tsx}"],
    hostAdapter: [
      "apps/web/src/router.tsx",
      "apps/web/src/routes/__root.tsx",
      "apps/web/src/providers.tsx",
      "apps/web/src/app/runtime.ts",
      "apps/web/src/server/api.ts",
      "apps/web/src/query-client.ts",
      "apps/web/src/routes/api/**/*.ts",
      "packages/ui/src/hooks/use-document-keydown.ts",
      "packages/ui/src/hooks/use-dispose-on-unmount.ts",
      "packages/ui/src/hooks/use-entered-viewport.ts",
      "packages/ui/src/hooks/use-lazy-image-source.ts",
      "packages/ui/src/hooks/use-preload-images.ts",
      "packages/ui/src/hooks/use-preload-when-idle.ts",
      "packages/ui/src/hooks/use-refocus-after-removal.ts",
      "packages/ui/src/hooks/use-retry-on-reconnect.ts",
      "packages/ui/src/hooks/use-virtual-windows.ts",
      "packages/ui/src/lib/browser-list-store.ts",
      "packages/ui/src/lib/single-key-shortcuts.ts",
      "packages/ui/src/theme.tsx",
      "apps/web/src/server/backend-handler.ts",
      "packages/api/src/backend-proxy.ts",
      "packages/api/src/server.ts",
      "packages/api/src/node.ts",
      "packages/api/src/node-backend-proxy.ts",
      "packages/api/src/node-request.ts",
      "packages/api/src/node-request-body.ts",
      "packages/api/src/node-response-stream.ts",
    ],
    // These workflows use finite discriminants; ordinary Query views remain data-first.
    statePresenter: [
      "packages/features/src/uploads/react/started-upload-row.tsx",
      "packages/features/src/uploads/react/upload-tray.tsx",
      "packages/features/src/cloud/react/cloud-content.tsx",
      "packages/features/src/cloud/react/cloud-screen-fallback.tsx",
    ],
  },
  protocolModules: ["@hyori-cloud/api", "@hyori-cloud/api/server", "@hyori-cloud/api/node"],
  productModules: ["@hyori-cloud/client-sdk", "@hyori-cloud/features"],
  protocolMarkers: ["uploads.begin", "uploads.complete", "uploadId", "partNumber"],
  discriminants: ["phase", "status", "state", "section"],
});

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.output/**",
      "**/routeTree.gen.ts",
      "apps/web/src/env.ts",
      "tooling/fernando-lint/**",
    ],
  },
  ...profile.map((config) => ({ ...config, basePath: rootDir })),
  {
    ...reactHooks.configs.flat.recommended,
    basePath: rootDir,
    files: [
      "packages/features/src/**/*.{ts,tsx}",
      "packages/client-sdk/src/react/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
      "apps/web/src/**/*.{ts,tsx}",
    ],
    languageOptions: profile[0].languageOptions,
  },
];
