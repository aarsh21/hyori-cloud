import { RpcGroup } from "@hyori-cloud/lib/effect/rpc";
import { authOperations } from "#core/features/auth/api/rpc";
import { filesOperations } from "#core/features/files/api/rpc";
import { uploadsOperations } from "#core/features/uploads/api/rpc";
import { sharesOperations } from "#core/features/shares/api/rpc";
import { adminOperations } from "#core/features/admin/api/rpc";
import { photosOperations } from "#core/features/photos/api/rpc";

export const operations = [
  ...authOperations,
  ...filesOperations,
  ...uploadsOperations,
  ...sharesOperations,
  ...adminOperations,
  ...photosOperations,
] as const;

export const ApiRpc = RpcGroup.make(...operations.map((operation) => operation.rpc));

export type Api = typeof ApiRpc;

export * from "#core/features/auth/api/schema";

export * from "#core/features/files/api/schema";

export * from "#core/features/uploads/api/schema";

export * from "#core/features/shares/api/schema";

export * from "#core/features/admin/api/schema";

export * from "#core/features/photos/api/schema";
