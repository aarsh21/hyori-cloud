import { expect, spyOn, test } from "bun:test";
import { DatabaseFailure, SurrealDatabase, Transaction } from "@hyori-cloud/lib/surreal";
import { UserRecord } from "#core/features/auth/db";

const config = {
  url: "http://database.invalid",
  namespace: "boundary_test",
  database: "boundary_test",
  username: "test",
  password: "test",
};

const account = {
  key: "owner",
  email: "owner@example.test",
  name: "Owner",
  role: "user",
  quotaBytes: 100,
  usedBytes: 5,
  reservedBytes: 0,
  passwordHash: "test-hash",
  status: "active",
} satisfies UserRecord;

test("persistence reads decode the owning account schema", async () => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ result: [{ status: "OK", result: [account] }] }),
  );

  try {
    const transaction = new Transaction(new SurrealDatabase(config));
    const result = await transaction.get(UserRecord, "user", account.key);
    expect(result).toEqual(account);
  } finally {
    fetch.mockRestore();
  }
});

test.each([
  { label: "unexpected RPC shape", body: { result: "not a statement list" } },
  {
    label: "unknown statement status",
    body: { result: [{ status: "SUCCESS", result: [account] }] },
  },
  {
    label: "invented account role",
    body: { result: [{ status: "OK", result: [{ ...account, role: "super-admin" }] }] },
  },
  {
    label: "string quota",
    body: { result: [{ status: "OK", result: [{ ...account, quotaBytes: "100" }] }] },
  },
  {
    label: "missing account fields",
    body: { result: [{ status: "OK", result: [{ key: account.key }] }] },
  },
])("rejects $label before a typed account leaves persistence", async ({ body }) => {
  const fetch = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));

  try {
    const transaction = new Transaction(new SurrealDatabase(config));
    await expect(transaction.get(UserRecord, "user", account.key)).rejects.toBeInstanceOf(
      DatabaseFailure,
    );
  } finally {
    fetch.mockRestore();
  }
});
