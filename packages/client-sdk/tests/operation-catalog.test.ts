import { expect, test } from "bun:test";
import { Schema } from "@hyori-cloud/lib/effect";
import { Rpc } from "@hyori-cloud/lib/effect/rpc";
import { MutationObserver, QueryClient } from "@hyori-cloud/lib/query-core";
import { deriveOperations } from "#client-sdk/operation-catalog";
import { createTransport } from "#client-sdk/transport";

const transport = createTransport({
  fetch: async () => Response.json({ ok: true, value: "decoded" }),
});

function declaration(tag: string) {
  return {
    rpc: Rpc.make(tag, { payload: Schema.Struct({}), success: Schema.String }),
    kind: "query" as const,
  };
}

test("catalog paths reject prototype mutation, duplicate leaves and namespace collisions", () => {
  for (const tag of [
    "__proto__.pollute",
    "constructor.method",
    "fixture.prototype.method",
    "fixture..read",
    "",
  ]) {
    expect(() => deriveOperations([declaration(tag)], transport.invoke, "fixture")).toThrow(
      "Unsafe operation path",
    );
  }

  expect(() =>
    deriveOperations(
      [declaration("fixture.read"), declaration("fixture.read")],
      transport.invoke,
      "fixture",
    ),
  ).toThrow("Duplicate operation");
  expect(() =>
    deriveOperations(
      [declaration("fixture"), declaration("fixture.read")],
      transport.invoke,
      "fixture",
    ),
  ).toThrow("namespace collides");
  expect(() =>
    deriveOperations(
      [declaration("fixture.read"), declaration("fixture")],
      transport.invoke,
      "fixture",
    ),
  ).toThrow("Duplicate operation");
});

test("a newly declared mutation composes typed callbacks with its own declared invalidation", async () => {
  const catalog = deriveOperations(
    [
      {
        rpc: Rpc.make("fixture.read", { payload: Schema.Struct({}), success: Schema.String }),
        kind: "query",
      },
      {
        rpc: Rpc.make("fixture.write", { payload: Schema.Struct({}), success: Schema.String }),
        kind: "mutation",
        invalidates: ["fixture.read"],
      },
    ] as const,
    transport.invoke,
    "fixture",
  );

  const client = new QueryClient();
  let received = "";
  catalog.mutation.fixture.write.setDefaults(client, {
    onSuccess(value) {
      received = value;
    },
  });
  await client.fetchQuery(catalog.query.fixture.read.getOptions({}));
  await new MutationObserver(client, catalog.mutation.fixture.write.mutationOptions()).mutate({});
  expect(received).toBe("decoded");
  expect(client.getQueryState(catalog.query.fixture.read.getKey({}))?.isInvalidated).toBe(true);
  client.clear();
});

test("catalog supports safe own-property names and binds validated declared outputs", async () => {
  const operations = [
    {
      rpc: Rpc.make("toString.read", { payload: Schema.Struct({}), success: Schema.String }),
      kind: "query",
    },
  ] as const;

  const catalog = deriveOperations(operations, transport.invoke, "fixture");

  expect(await catalog.rpc.toString.read({})).toBe("decoded");
  expect(
    await catalog.query.toString.read
      .getOptions({})
      .queryFn({ signal: new AbortController().signal }),
  ).toBe("decoded");
  expect(catalog.query.toString.read.getOptions({}).queryKey.slice()).toEqual([
    "hyori",
    "toString.read",
    "fixture",
    { input: {} },
  ]);
});
