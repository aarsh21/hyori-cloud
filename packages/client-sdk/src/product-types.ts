import type { operations } from "@hyori-cloud/api/rpc";
import type { OperationTree } from "#client-sdk/inference";

export type RPC = OperationTree<(typeof operations)[number], "rpc">;

export type Query = OperationTree<(typeof operations)[number], "query">;

export type Mutation = OperationTree<(typeof operations)[number], "mutation">;
