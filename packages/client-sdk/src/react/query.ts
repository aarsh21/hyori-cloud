import type { Client } from "#client-sdk/client";

/** A pure view of the bound catalog: no cache, transport, or provider is created. */
export function createQuery(sdkClient: Client) {
  return sdkClient.query;
}

export type { Query, Mutation } from "#client-sdk/product-types";
