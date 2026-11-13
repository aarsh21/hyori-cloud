import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import type { z } from "zod";
import {
  generateRustContracts,
  parseRustContractManifest,
  runRustContractsCli,
} from "./generate-rust-contracts.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Deliberately synthetic: these tiny declarations prove compiler behavior, not the Rust product pipeline.
function fixture() {
  return parseRustContractManifest(
    JSON.stringify({
      schemas: {
        Empty: { type: "object", properties: {} },
        Fault: {
          type: "object",
          required: ["code"],
          properties: { code: { const: "fixture.failed" } },
        },
        User: {
          type: "object",
          properties: {
            id: { type: "string", pattern: "^[a-z]+$", minLength: 1, maxLength: 8 },
            label: { type: ["string", "null"], minLength: 2, maxLength: 12 },
            age: { type: "integer", minimum: 0, maximum: 120 },
            role: { enum: ["reader", "writer"] },
          },
          required: ["id", "role", "age"],
        },
        UserList: {
          type: "array",
          items: { $ref: "#/$defs/User" },
          minItems: 1,
          maxItems: 2,
        },
      },
      operations: [
        {
          name: "users.list",
          input: "Empty",
          output: "UserList",
          error: "Fault",
          kind: "query",
          invalidates: [],
          resetCache: false,
        },
        {
          name: "users.save",
          input: "User",
          output: "User",
          error: "Fault",
          kind: "mutation",
          invalidates: ["users"],
          resetCache: true,
        },
      ],
    }),
  );
}

function schemaFixture(schema: z.infer<ReturnType<typeof z.json>>) {
  return parseRustContractManifest(
    JSON.stringify({ schemas: { Example: schema }, operations: [] }),
  );
}

async function temporary() {
  const directory = await mkdtemp(join(tmpdir(), "hyori-rust-generator-"));
  await symlink(join(root, "packages/api/node_modules"), join(directory, "node_modules"), "dir");

  return directory;
}

async function emit(directory: string, manifest = fixture()) {
  for (const [name, content] of Object.entries(generateRustContracts(manifest))) {
    await writeFile(join(directory, name), content);
  }
}

async function runConsumer(directory: string, source: string) {
  const path = join(directory, "runtime.ts");
  await writeFile(path, source);
  const result = spawnSync(process.execPath, [path], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
}

test("generation is byte deterministic across manifest, property, definition, and operation order", () => {
  const first = fixture();
  const second = fixture();
  second.operations.reverse();
  second.schemas = Object.fromEntries(Object.entries(second.schemas).reverse());
  const user = second.schemas.User!;
  user.properties = Object.fromEntries(Object.entries(user.properties!).reverse());
  assert.deepEqual(generateRustContracts(first), generateRustContracts(second));
  const generated = generateRustContracts(first);
  assert.ok(
    generated["schemas.ts"].indexOf("export const User =") <
      generated["schemas.ts"].indexOf("export const UserList ="),
  );
  assert.match(generated["operations.ts"], /kind: "query"/);
  assert.match(generated["operations.ts"], /invalidates: \["users"\]/);
  assert.match(generated["operations.ts"], /resetCache: true/);
  assert.doesNotMatch(
    generated["schemas.ts"] + generated["operations.ts"],
    /from "(?:effect|@effect|@hyori-cloud\/core)/,
  );
});

test("JSON client catalog preserves the Effect RPC codecs, tags and mutation policies", async () => {
  const directory = await temporary();

  try {
    await emit(directory);
    await runConsumer(
      directory,
      `
      import assert from "node:assert/strict";
      import { operations, ApiRpc } from "./operations";
      import { operations as client } from "./client-operations";
      assert.equal(client.length, 2);
      assert.equal(ApiRpc.requests.size, 2);
      for (const [index, operation] of operations.entries()) {
        const descriptor = client[index];
        assert.equal(descriptor.rpc._tag, operation.rpc._tag);
        assert.equal(descriptor.rpc.payloadSchema, operation.rpc.payloadSchema);
        assert.equal(descriptor.rpc.successSchema, operation.rpc.successSchema);
        assert.equal(descriptor.rpc.errorSchema, operation.rpc.errorSchema);
        assert.equal(descriptor.kind, operation.kind);
        assert.deepEqual(descriptor.invalidates, operation.invalidates);
        assert.equal(descriptor.resetCache, operation.resetCache);
        assert.equal(ApiRpc.requests.get(operation.rpc._tag), operation.rpc);
      }
      `,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("generated runtime validates optional vs nullable, bounds, enums and ordinary/closed object keys", async () => {
  const directory = await temporary();

  try {
    const manifest = fixture();
    manifest.schemas.Closed = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    manifest.schemas.NumberValue = {
      type: "number",
      exclusiveMinimum: 0,
      exclusiveMaximum: 10,
      multipleOf: 0.5,
    };
    manifest.schemas.ClosedEmpty = { type: "object", additionalProperties: false };
    manifest.schemas.Unicode = { type: "string", minLength: 1, maxLength: 1 };
    manifest.schemas.SafeInteger = { type: "integer" };
    manifest.schemas.ReservedProperty = {
      type: "object",
      properties: { default: { type: "boolean" } },
      required: ["default"],
    };
    await emit(directory, manifest);
    await runConsumer(
      directory,
      `
      import assert from "node:assert/strict";
      import { Schema } from "@hyori-cloud/lib/effect";
      import { User, UserList, Closed, ClosedEmpty, Empty, NumberValue, Unicode, SafeInteger, ReservedProperty } from "./schemas";
      const valid = { id: "ada", age: 42, role: "reader" };
      assert.ok(Schema.is(User)(valid));
      assert.ok(Schema.is(User)({ ...valid, label: null }));
      assert.ok(Schema.is(User)({ ...valid, label: "AB" }));
      assert.ok(Schema.is(User)({ ...valid, label: undefined }));
      assert.deepEqual(JSON.parse(JSON.stringify(Schema.encodeUnknownSync(User)({ ...valid, label: undefined }))), valid);
      for (const invalid of [
        { ...valid, label: "A" },
        { ...valid, label: "too long a label" }, { ...valid, id: "UPPER" },
        { ...valid, id: "toolongname" }, { ...valid, age: -1 },
        { ...valid, age: 121 }, { ...valid, age: 1.5 },
        { ...valid, role: "admin" }, { id: "ada", role: "reader" },
      ]) assert.equal(Schema.is(User)(invalid), false, JSON.stringify(invalid));
      assert.ok(Schema.is(UserList)([valid]));
      assert.equal(Schema.is(UserList)([]), false);
      assert.equal(Schema.is(UserList)([valid, valid, valid]), false);
      assert.deepEqual(Schema.decodeUnknownSync(User)({ ...valid, extra: "ignored" }), valid);
      assert.throws(() => Schema.decodeUnknownSync(Closed)({ id: "x", extra: true }));
      assert.ok(Schema.is(NumberValue)(0.5));
      for (const value of [0, 10, 0.3, Infinity, NaN]) assert.equal(Schema.is(NumberValue)(value), false);
      assert.ok(Schema.is(Unicode)("😀"));
      assert.equal(Schema.is(Unicode)("😀😀"), false);
      assert.ok(Schema.is(SafeInteger)(Number.MAX_SAFE_INTEGER));
      assert.equal(Schema.is(SafeInteger)(Number.MAX_SAFE_INTEGER + 1), false);
      assert.ok(Schema.is(ReservedProperty)({ default: true }));
      for (const invalid of [1, "x", [], null]) {
        assert.equal(Schema.is(Empty)(invalid), false);
        assert.throws(() => Schema.decodeUnknownSync(Empty)(invalid));
      }
      assert.ok(Schema.is(Empty)({}));
      assert.ok(Schema.is(ClosedEmpty)({}));
      assert.equal(Schema.is(ClosedEmpty)({ extra: true }), false);
    `,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("the JSON wire catalog and codecs preserve the Effect contract on asymmetric boundary inputs", async () => {
  const directory = await temporary();

  try {
    const manifest = fixture();
    Object.assign(manifest.schemas, {
      Closed: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      ClosedEmpty: { type: "object", additionalProperties: false },
      Unicode: { type: "string", minLength: 1, maxLength: 1 },
      Counter: { type: "integer", format: "uint64" },
      Part: { type: "integer", format: "uint32" },
      Signed: { type: "integer", format: "int32" },
      Fraction: { type: "number", exclusiveMinimum: 0, maximum: 10, multipleOf: 0.5 },
      Headers: { type: "object", additionalProperties: { type: "string" } },
      Timestamp: { type: "string", anyOf: [{ format: "date" }, { format: "date-time" }] },
      NullableDate: { type: ["string", "null"], format: "date" },
      Conjunction: {
        allOf: [
          { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
          { type: "object", properties: { age: { type: "integer" } }, required: ["age"] },
        ],
      },
      Exclusive: {
        oneOf: [
          { type: "number", minimum: 0 },
          { type: "number", maximum: 5 },
        ],
      },
      Reference: {
        $ref: "#/$defs/User",
        type: "object",
        properties: { age: { type: "integer", minimum: 18 } },
        required: ["age"],
      },
    });
    await emit(directory, manifest);
    await runConsumer(
      directory,
      `
      import assert from "node:assert/strict";
      import { Schema } from "@hyori-cloud/lib/effect";
      import * as effect from "./schemas";
      import * as wire from "./wire-schemas";
      import { operations as rpc } from "./operations";
      import { operations } from "./wire-operations";
      const valid = { id: "ada", age: 42, role: "reader" };
      const candidates = [undefined, null, true, false, -2147483649, -2147483648, -1, 0, 0.3, 0.5, 1, 1.5, 5, 6, 10, 11, 2147483647, 2147483648, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity,
        "", "A", "😀", "😀😀", "2024-02-29", "2025-02-29", "2016-12-31T23:59:60Z", "2026-11-05T12:00:60Z", "2026-11-05t14:13:12.123+05:30", "2026-11-05T00:00:00", "2026-11-05T12:00:00+25:00",
        {}, { extra: true }, { id: "x" }, { id: "x", extra: true }, { id: "x", age: 19 }, { "Content-Type": "text/plain" }, { "Content-Length": 3 }, [], [valid], [valid, valid], [valid, valid, valid], valid,
        { ...valid, extra: "strip" }, { ...valid, label: undefined }, { ...valid, label: null }, { ...valid, label: "A" }, { ...valid, label: "AB" }, { ...valid, label: "too long a label" }, { ...valid, id: "UPPER" }, { ...valid, id: "toolongname" }, { ...valid, age: 17 }, { ...valid, age: 121 }, { ...valid, age: 1.5 }, { ...valid, role: "admin" }];
      let cases = 0;
      for (const name of Object.keys(wire)) for (const input of candidates) {
        const before = Schema.decodeUnknownEither(effect[name])(input);
        const after = wire[name].safeParse(input);
        assert.equal(after.success, before._tag === "Right", name + ": " + String(JSON.stringify(input)));
        if (after.success) assert.deepEqual(after.data, before.right, name);
        cases++;
      }
      assert(cases > 900);
      assert.equal(operations.length, rpc.length);
      for (const [index, operation] of operations.entries()) {
        assert.equal(operation.rpc._tag, rpc[index].rpc._tag);
        assert.equal(operation.kind, rpc[index].kind);
        assert.deepEqual(operation.invalidates, rpc[index].invalidates);
        assert.equal(operation.resetCache, rpc[index].resetCache);
        assert.deepEqual(operation.rpc.payloadSchema.parse(valid), Schema.encodeUnknownSync(rpc[index].rpc.payloadSchema)(valid));
      }
    `,
    );

    for (const name of ["z", "Contract"]) {
      assert.throws(
        () => generateRustContracts({ ...fixture(), schemas: { [name]: { type: "string" } } }),
        /reserved schema identifier/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Rust numeric formats and inherited date formats preserve runtime validation", async () => {
  const directory = await temporary();

  try {
    const manifest = fixture();
    manifest.schemas.Counter = { type: "integer", format: "uint64", minimum: 0 };
    manifest.schemas.Part = { type: "integer", format: "uint32" };
    manifest.schemas.Headers = { type: "object", additionalProperties: { type: "string" } };
    manifest.schemas.Fraction = { type: "number", format: "double" };
    manifest.schemas.Timestamp = {
      type: "string",
      maxLength: 40,
      anyOf: [{ format: "date" }, { format: "date-time" }],
    };
    manifest.schemas.NullableDate = { type: ["string", "null"], format: "date" };
    await emit(directory, manifest);
    await runConsumer(
      directory,
      `
      import assert from "node:assert/strict";
      import { Schema } from "@hyori-cloud/lib/effect";
      import { Counter, Part, Fraction, Timestamp, NullableDate, Headers } from "./schemas";
      assert.ok(Schema.is(Headers)({ "Content-Type": "application/octet-stream" }));
      for (const value of [[], null, { "Content-Length": 3 }]) assert.equal(Schema.is(Headers)(value), false);
      assert.ok(Schema.is(Counter)(Number.MAX_SAFE_INTEGER));
      for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.equal(Schema.is(Counter)(value), false);
      assert.ok(Schema.is(Part)(4294967295));
      assert.equal(Schema.is(Part)(4294967296), false);
      assert.ok(Schema.is(Fraction)(1.25));
      assert.equal(Schema.is(Fraction)(Infinity), false);
      for (const value of ["2024-02-29", "2026-11-05T14:13:12Z", "2026-11-05t14:13:12.123+05:30", "2016-12-31T23:59:60Z"])
        assert.ok(Schema.is(Timestamp)(value), value);
      for (const value of ["2025-02-29", "2024-04-31", "2026-13-01", "2026-11-05T25:00:00Z", "2026-11-05T00:00:00", "2026-11-05T12:00:60Z", "2026-11-05T12:00:00+25:00", "not a date", 42, null])
        assert.equal(Schema.is(Timestamp)(value), false, String(value));
      assert.ok(Schema.is(NullableDate)(null));
      assert.ok(Schema.is(NullableDate)("2024-02-29"));
      assert.equal(Schema.is(NullableDate)("2025-02-29"), false);
    `,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("references and allOf/anyOf/oneOf preserve constraints and exclusive matching", async () => {
  const directory = await temporary();

  try {
    const manifest = parseRustContractManifest(
      JSON.stringify({
        schemas: {
          User: {
            $defs: { Id: { type: "string", minLength: 2 } },
            type: "object",
            required: ["id"],
            properties: { id: { $ref: "#/$defs/Id" } },
          },
          Named: {
            allOf: [
              { $ref: "#/$defs/User" },
              { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            ],
          },
          Maybe: { anyOf: [{ $ref: "#/$defs/Named" }, { type: "null" }] },
          Exactly: {
            oneOf: [
              { type: "number", minimum: 0 },
              { type: "integer", maximum: 10 },
            ],
          },
          Literal: { type: "string", enum: ["yes", "no"] },
          NullLiteral: { type: "null", const: null },
          ArrayIntersection: {
            allOf: [
              { type: "array", items: { type: "string" }, minItems: 1 },
              { type: "array", items: { type: "string" }, maxItems: 2 },
            ],
          },
          ExclusiveObject: {
            oneOf: [
              { type: "object", properties: { left: { type: "string" } }, required: ["left"] },
              { type: "object", properties: { right: { type: "string" } }, required: ["right"] },
            ],
          },
        },
        operations: [],
      }),
    );

    await emit(directory, manifest);
    await runConsumer(
      directory,
      `
      import assert from "node:assert/strict";
      import { Schema } from "@hyori-cloud/lib/effect";
      import { Named, Maybe, Exactly, Literal, NullLiteral, ArrayIntersection, ExclusiveObject } from "./schemas";
      assert.ok(Schema.is(Named)({ id: "ab", name: "Ada" }));
      assert.equal(Schema.is(Named)({ id: "a", name: "Ada" }), false);
      assert.equal(Schema.is(Named)({ id: "ab" }), false);
      assert.ok(Schema.is(Maybe)(null));
      assert.ok(Schema.is(Maybe)({ id: "ab", name: "Ada" }));
      assert.equal(Schema.is(Exactly)(5), false);
      assert.ok(Schema.is(Exactly)(12));
      assert.ok(Schema.is(Exactly)(-1));
      assert.equal(Schema.is(Exactly)(-1.5), false);
      assert.ok(Schema.is(Literal)("yes"));
      assert.equal(Schema.is(Literal)("other"), false);
      assert.ok(Schema.is(NullLiteral)(null));
      assert.equal(Schema.is(NullLiteral)(0), false);
      assert.ok(Schema.is(ArrayIntersection)(["x"]));
      assert.equal(Schema.is(ArrayIntersection)([]), false);
      assert.equal(Schema.is(ArrayIntersection)(["x", "y", "z"]), false);
      assert.equal(Schema.is(ExclusiveObject)({ left: "x", right: "y" }), false);
      assert.throws(() => Schema.decodeUnknownSync(ExclusiveObject)({ left: "x", right: "y" }));
      assert.deepEqual(Schema.decodeUnknownSync(ExclusiveObject)({ left: "x" }), { left: "x" });
      assert.throws(() => Schema.decodeUnknownSync(Exactly)(5));
      assert.deepEqual(Schema.encodeSync(Named)({ id: "ab", name: "Ada" }), { id: "ab", name: "Ada" });
    `,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// This test runs the TypeScript compiler as a child process: about two seconds on an idle two-core
// machine, and past the default five-second limit when other work shares the processors.
const compiledConsumers =
  "generated public RPC consumers retain schema, client and literal metadata inference";

test(compiledConsumers, { timeout: 30_000 }, async () => {
  const directory = await temporary();

  try {
    const manifest = fixture();
    manifest.schemas.ExtendedUser = {
      allOf: [
        { $ref: "#/$defs/User" },
        { type: "object", properties: { active: { const: true } }, required: ["active"] },
      ],
    };
    manifest.schemas.Result = { oneOf: [{ $ref: "#/$defs/ExtendedUser" }, { type: "null" }] };
    manifest.schemas.Role = { type: "string", enum: ["reader", "writer"] };
    await emit(directory, manifest);
    await writeFile(
      join(directory, "consumer.ts"),
      `
      import { Effect } from "@hyori-cloud/lib/effect";
      import type { RpcClient } from "@hyori-cloud/lib/effect/rpc";
      import { operations } from "./operations";
      import type { Api } from "./operations";
      import type { User, ExtendedUser, Result, Role } from "./schemas";
      declare const client: RpcClient.FromGroup<Api>;
      const valid: User = { id: "ada", age: 42, role: "reader" };
      const result: Effect.Effect<ReadonlyArray<User>, { readonly code: "fixture.failed" }> = client.users.list({});
      client.users.save({ ...valid, label: null });
      const kind: "query" = operations[0].kind;
      const invalidation: "users" = operations[1].invalidates[0];
      const reset: true = operations[1].resetCache;
      const optionalUndefined: User = { ...valid, label: undefined };
      // @ts-expect-error optional values retain their string-or-null contract
      const invalidOptional: User = { ...valid, label: 123 };
      void optionalUndefined;
      // @ts-expect-error literal enum is precise
      client.users.save({ ...valid, role: "admin" });
      // @ts-expect-error required fields are preserved
      client.users.save({ id: "ada" });
      // @ts-expect-error no handwritten broad operation catalog
      client.users.missing({});
      const extended: ExtendedUser = { ...valid, active: true };
      const union: Result = null;
      const role: Role = "reader";
      // @ts-expect-error conjunction retains the required literal field
      const missingIntersection: ExtendedUser = valid;
      // @ts-expect-error exclusive union retains member types
      const wrongUnion: Result = 5;
      // @ts-expect-error enum combined with primitive type stays literal, not string
      const wrongLiteral: Role = "administrator";
      void [result, kind, invalidation, reset, invalidOptional, extended, union, role, missingIntersection, wrongUnion, wrongLiteral];
    `,
    );
    await writeFile(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          strict: true,
          exactOptionalPropertyTypes: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["./*.ts"],
      }),
    );

    const result = spawnSync(
      process.execPath,
      [
        join(root, "node_modules/typescript/bin/tsc"),
        "--project",
        join(directory, "tsconfig.json"),
      ],
      { encoding: "utf8", cwd: root },
    );

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("definitions deduplicate only when equal and reject dangling or cyclic references", () => {
  const equal = parseRustContractManifest(
    JSON.stringify({
      schemas: {
        Left: {
          type: "object",
          $defs: { Common: { type: "string", minLength: 1 } },
          properties: { id: { $ref: "#/$defs/Common" } },
        },
        Right: { type: "object", $defs: { Common: { minLength: 1, type: "string" } } },
      },
      operations: [],
    }),
  );

  assert.equal(
    generateRustContracts(equal)["schemas.ts"].match(/export const Common =/g)?.length,
    1,
  );
  equal.schemas.Common = {
    type: "string",
    minLength: 1,
    title: "Common",
    description: "Root-only Schemars metadata",
  };
  assert.equal(
    generateRustContracts(equal)["schemas.ts"].match(/export const Common =/g)?.length,
    1,
  );
  equal.schemas.Right!.$defs!.Common = { type: "number" };
  assert.throws(() => generateRustContracts(equal), /conflicting schema definition Common/);
  assert.throws(
    () => generateRustContracts(schemaFixture({ $ref: "#/$defs/Missing" })),
    /dangling reference Missing/,
  );
  assert.throws(
    () => generateRustContracts(schemaFixture({ $ref: "https://example.org/schema" })),
    /unsupported reference/,
  );
  assert.throws(
    () => generateRustContracts(schemaFixture({ $ref: "#/$defs/Example" })),
    /cyclic schema references.*Example -> Example/,
  );

  const cycle = parseRustContractManifest(
    '{"schemas":{"A":{"$ref":"#/$defs/B"},"B":{"$ref":"#/$defs/A"}},"operations":[]}',
  );

  assert.throws(() => generateRustContracts(cycle), /A -> B -> A/);
});

test("reject unsupported schemas rather than weakening runtime validation", () => {
  for (const [schema, error] of [
    [{}, /unconstrained schema/],
    [{ type: "string", format: "email" }, /format/],
    [{ type: "array", items: { type: "string" }, uniqueItems: true }, /uniqueItems/],
    [{ type: "array" }, /explicit items/],
    [{ type: "object", additionalProperties: true }, /additionalProperties/],
    [{ type: "object", required: ["missing"] }, /no declaration/],
    [{ type: "string", minLength: 3, maxLength: 1 }, /minLength exceeds/],
    [{ type: "integer", maximum: Number.MAX_SAFE_INTEGER + 1 }, /safe numeric range/],
    [{ type: "boolean", pattern: "x" }, /requires an explicit string/],
    [{ type: "string", pattern: "[" }, /invalid Unicode regular expression/],
    [{ type: "string", minLength: -1 }, /Too small/],
    [{ type: "bogus" }, /unsupported schema type/],
    [{ enum: ["a", "a"] }, /duplicate enum/],
  ] satisfies [z.infer<ReturnType<typeof z.json>>, RegExp][]) {
    assert.throws(() => generateRustContracts(schemaFixture(schema)), error);
  }

  assert.match(
    generateRustContracts(schemaFixture({ "x-hyori-unknown": true }))["schemas.ts"],
    /Schema.Unknown/,
  );
  assert.match(
    generateRustContracts(parseRustContractManifest('{"schemas":{"Unknown":{}},"operations":[]}'))[
      "schemas.ts"
    ],
    /Schema.Unknown/,
  );
});

test("reject conflicting names, duplicate keys, operations and prototype namespace collisions", () => {
  assert.throws(
    () =>
      parseRustContractManifest(
        '{"schemas":{"A":{"type":"string"},"A":{"type":"number"}},"operations":[]}',
      ),
    /duplicate JSON key "A"/,
  );
  assert.throws(
    () =>
      parseRustContractManifest(
        '{"schemas":{"A":{"type":"string","\\u0074ype":"number"}},"operations":[]}',
      ),
    /duplicate JSON key "type"/,
  );

  for (const name of ["Schema", "Api", "constructor", "__proto__", "default", "not-valid"]) {
    const manifest = fixture();
    Object.defineProperty(manifest.schemas, name, { value: { type: "string" }, enumerable: true });
    assert.throws(() => generateRustContracts(manifest), /unsafe or reserved schema identifier/);
  }

  const duplicate = fixture();
  duplicate.operations.push(duplicate.operations[0]!);
  assert.throws(() => generateRustContracts(duplicate), /duplicate operation/);

  for (const name of ["users.constructor", "__proto__.list", "users.toString"]) {
    const manifest = fixture();
    manifest.operations[0]!.name = name;
    assert.throws(() => generateRustContracts(manifest), /unsafe operation namespace/);
  }

  const prefix = fixture();
  prefix.operations[0]!.name = "users";
  assert.throws(() => generateRustContracts(prefix), /namespace collision/);
  const missing = fixture();
  missing.operations[0]!.input = "Missing";
  assert.throws(() => generateRustContracts(missing), /dangling schema Missing/);
});

test("CLI check is byte-exact, read-only, and reports missing/stale artifacts", async () => {
  const directory = await temporary();

  try {
    const input = join(directory, "manifest.json");
    const output = join(directory, "generated");
    await writeFile(input, JSON.stringify(fixture()));
    const args = ["--input", input, "--output", output];
    await assert.rejects(runRustContractsCli([...args, "--check"]), /stale or missing artifacts/);
    await assert.rejects(readFile(join(output, "schemas.ts")), /ENOENT/);
    await runRustContractsCli(args);
    await runRustContractsCli([...args, "--check"]);
    const stale = "// stale\n";
    await writeFile(join(output, "operations.ts"), stale);
    await assert.rejects(runRustContractsCli([...args, "--check"]), /operations.ts/);
    assert.equal(await readFile(join(output, "operations.ts"), "utf8"), stale);
    await runRustContractsCli(args);
    await runRustContractsCli([...args, "--check"]);
    await assert.rejects(
      runRustContractsCli(["--input", input, "--input", input, "--output", output]),
      /duplicate flag/,
    );
    await assert.rejects(runRustContractsCli(["--input", "--output", output]), /needs a path/);
    await assert.rejects(runRustContractsCli([...args, "--surprise"]), /unsupported flag/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI refuses output symlinks and input/output aliasing", async () => {
  const directory = await temporary();

  try {
    const input = join(directory, "manifest.json");
    const output = join(directory, "generated");
    await writeFile(input, JSON.stringify(fixture()));
    await mkdir(output);
    await symlink(input, join(output, "schemas.ts"));
    await assert.rejects(
      runRustContractsCli(["--input", input, "--output", output]),
      /non-regular file/,
    );
    assert.equal(await readFile(input, "utf8"), JSON.stringify(fixture()));
    await rm(join(output, "schemas.ts"));
    const aliasedInput = join(output, "schemas.ts");
    await writeFile(aliasedInput, JSON.stringify(fixture()));
    await assert.rejects(
      runRustContractsCli(["--input", aliasedInput, "--output", output]),
      /must not overwrite the manifest/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
