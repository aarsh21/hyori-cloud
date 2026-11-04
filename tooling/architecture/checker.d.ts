// The vendored JavaScript checker has no declarations; describe only its consumed public contract.
declare module "*fernando-lint/index.js" {
  type Config = import("../fernando-lint/node_modules/eslint/lib/types/index.d.ts").Linter.Config;

  export function createArchitectureConfig(options: {
    rootDir: string;
    tsconfig: string;
    sourceRoles: {
      portableFeature: string[];
      designSystem?: string[];
      statePresenter?: string[];
      hostAdapter?: string[];
      sdkReact?: string[];
    };
    protocolModules?: string[];
    productModules?: string[];
    protocolMarkers?: string[];
    discriminants?: string[];
  }): [Config, ...Config[]];
}

declare module "*fernando-lint/node_modules/eslint/lib/api.js" {
  export const ESLint: typeof import("../fernando-lint/node_modules/eslint/lib/types/index.d.ts").ESLint;
}
