import type { Client } from "@hyori-cloud/client-sdk";
import { cursorPagesOptions } from "#features/shared/react/use-cursor-pages.ts";

/** Everything the signed-in person has shared, newest first: one row per live grant. */
export function outgoingSharesOptions(sdk: Pick<Client, "query" | "rpc">) {
  return cursorPagesOptions(
    sdk.query.shares.outgoing,
    // The first page has no cursor at all; later ones pass back the server's opaque cursor.
    ({ cursor }, options) => sdk.rpc.shares.outgoing(cursor === null ? {} : { cursor }, options),
    {},
  );
}
