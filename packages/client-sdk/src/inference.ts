import type { Schema } from "@hyori-cloud/lib/effect";
import type { Rpc } from "@hyori-cloud/lib/effect/rpc";
import type { SDKError } from "#client-sdk/errors";

export declare const operationTypes: unique symbol;

export type OperationKind = "query" | "mutation";

export type OperationDeclaration = {
  readonly rpc: Rpc.Any & {
    readonly payloadSchema: Schema.Schema.All & { readonly Context: never };
    readonly successSchema: Schema.Schema.All & { readonly Context: never };
    readonly errorSchema: Schema.Schema.All & { readonly Context: never };
  };
  readonly kind: OperationKind;
  readonly invalidates?: readonly string[];
  readonly resetCache?: boolean;
};

export type TypeCarrier<
  I = unknown,
  O = unknown,
  E = unknown,
  K extends OperationKind = OperationKind,
> = {
  readonly [operationTypes]?: {
    readonly input: I;
    readonly output: O;
    readonly error: E;
    readonly kind: K;
  };
};

export type Payload<D extends OperationDeclaration> = Schema.Schema.Type<D["rpc"]["payloadSchema"]>;

export type Success<D extends OperationDeclaration> = Schema.Schema.Type<D["rpc"]["successSchema"]>;

export type Failure<D extends OperationDeclaration> =
  | Schema.Schema.Type<D["rpc"]["errorSchema"]>
  | SDKError;

export type CarrierFor<D extends OperationDeclaration> = TypeCarrier<
  Payload<D>,
  Success<D>,
  Failure<D>,
  D["kind"]
>;

export type AnyOperation = TypeCarrier;

export type InputOf<T extends TypeCarrier | ((...args: never[]) => void)> =
  T extends TypeCarrier<infer I, unknown, unknown>
    ? I
    : T extends (input: infer I, ...args: never[]) => void
      ? I
      : never;

export type OutputOf<T extends TypeCarrier | ((...args: never[]) => void)> =
  T extends TypeCarrier<unknown, infer O, unknown>
    ? O
    : T extends (...args: never[]) => infer O
      ? Awaited<O>
      : never;

export type ErrorOf<T extends TypeCarrier> =
  T extends TypeCarrier<unknown, unknown, infer E> ? E : never;

export type QueryOperationType = TypeCarrier<unknown, unknown, unknown, "query">;

type Path<Tag extends string, Value> = Tag extends `${infer Head}.${infer Rest}`
  ? { readonly [K in Head]: Path<Rest, Value> }
  : { readonly [K in Tag]: Value };

type Intersect<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;

export type OperationTree<
  D extends OperationDeclaration,
  Value extends "rpc" | "query" | "mutation",
> = Intersect<
  D extends unknown
    ? Value extends "rpc"
      ? Path<D["rpc"]["_tag"], import("#client-sdk/operation-catalog").RpcOperation<D>>
      : D["kind"] extends Value
        ? Path<
            D["rpc"]["_tag"],
            Value extends "query"
              ? import("#client-sdk/operation-catalog").QueryOperation<D>
              : import("#client-sdk/operation-catalog").MutationOperation<D>
          >
        : never
    : never
>;
