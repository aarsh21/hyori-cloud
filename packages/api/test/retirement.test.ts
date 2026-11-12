import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = new URL("../../../", import.meta.url);
const source = (path: string) => readFileSync(new URL(path, root), "utf8");

test("active API and web host have no legacy domain runtime or server credentials", () => {
  expect(existsSync(fileURLToPath(new URL("packages/core/package.json", root)))).toBe(false);

  for (const adapter of ["surreal", "storage", "crypto"])
    expect(existsSync(fileURLToPath(new URL(`packages/lib/src/${adapter}.ts`, root)))).toBe(false);

  for (const file of [
    "packages/api/src/index.ts",
    "packages/api/package.json",
    "packages/lib/package.json",
    "apps/web/src/server/api.ts",
  ])
    expect(source(file)).not.toMatch(
      /@hyori-cloud\/core|createHandler|SURREALDB|@aws-sdk\/client-s3/,
    );

  const schema = source("apps/web/.env.schema");
  expect(schema).not.toMatch(
    /HYORI_SETUP_TOKEN|HYORI_AUTH_SECRET|DATABASE_URL|RUSTFS_|HYORI_STORAGE_/,
  );
  expect(schema).toMatch(
    /@sensitive=true @dynamic @required=false @type=string\nHYORI_BACKEND_URL=/,
  );
  expect(source("apps/web/src/server/api.ts")).not.toMatch(/setInterval|maintenance|process\.env/);
});

test("fresh Compose and required real gates cannot silently restore the retired stack", () => {
  const compose = source("docker-compose.yml");
  expect(compose).toContain("name: hyori-cloud-rust");
  expect(compose).toContain("rust-postgres-data:");
  expect(compose).not.toMatch(/surreal|surreal-data|apps\/web\/\.env/);
  const rootManifest = source("package.json");
  expect(rootManifest).not.toContain("scripts/test-services.ts");
  expect(rootManifest).not.toContain("packages/core/test");

  for (const command of [
    "test:rust-services",
    "test:rust-sdk",
    "test:rust-upload-sdk",
    "test:rust-photos-sdk",
    "test:rust-admin-sdk",
  ])
    expect(rootManifest).toContain(`bun run ${command}`);

  const ci = source(".github/workflows/ci.yml");
  expect(ci).not.toContain("bun run test:services");
  expect(ci.match(/run: bun run test:rust-services/g)).toHaveLength(1);
  expect(ci).toContain("bun run test:rust-web-host");
  expect(ci).toContain("bun run contracts:check");
});
