import type { Schema } from "@hyori-cloud/lib/effect";
import { authHandlers } from "#core/features/auth/api/index";
import { filesHandlers } from "#core/features/files/api/index";
import { uploadsHandlers } from "#core/features/uploads/api/index";
import { sharesHandlers } from "#core/features/shares/api/index";
import { adminHandlers } from "#core/features/admin/api/index";
import { photosHandlers } from "#core/features/photos/api/index";
import type { operations } from "#core/rpc";
import type { RequestContext } from "#core/runtime";

type Operation = (typeof operations)[number];

export type Handlers = {
  [O in Operation as O["rpc"]["_tag"]]: (
    input: Schema.Schema.Type<O["rpc"]["payloadSchema"]>,
  ) => Promise<Schema.Schema.Type<O["rpc"]["successSchema"]>>;
};

export function createBindings(context: RequestContext): Handlers {
  return {
    ...authHandlers(context),
    ...filesHandlers(context),
    ...uploadsHandlers(context),
    ...sharesHandlers(context),
    ...adminHandlers(context),
    ...photosHandlers(context),
  } satisfies Handlers;
}
