import { expect, test } from "bun:test";
import { digest } from "@hyori-cloud/lib/crypto";
import { transact } from "@hyori-cloud/lib/surreal";
import { RequestContext, Runtime } from "#core/runtime";
import { config, ReviewDatabase, ReviewStorage } from "#core-test/review-fixture";

test("independent public-link cookies authorize concurrently through one bounded grant query", async () => {
  let lookups = 0;

  const database = new ReviewDatabase((query, variables) => {
    expect(query).toContain("FROM hc_grant");
    expect(query).toContain("expiresAt > $now");
    expect(variables.keys).toEqual([digest("tokenA"), digest("tokenB")]);
    expect(variables.limit).toBe(16);
    lookups += 1;

    return [
      { key: digest("tokenA"), shareId: "alpha", expiresAt: "2099-01-01T00:00:00.000Z" },
      { key: digest("tokenB"), shareId: "beta", expiresAt: "2099-01-01T00:00:00.000Z" },
    ];
  });

  const storage = new ReviewStorage(config.storage);
  const runtime = new Runtime(config, { database, storage });

  const ctx = new RequestContext(
    runtime,
    new Request(config.origin, {
      headers: { Cookie: "hyori_share_alpha=tokenA; hyori_share_beta=tokenB" },
    }),
  );

  try {
    const actor = await transact(database, (transaction) => ctx.actor(transaction));
    expect(actor.shareIds).toEqual(["alpha", "beta"]);
    expect(lookups).toBe(1);
    ctx.setShareCookie("gamma", "tokenC");
    expect(ctx.responseHeaders.getSetCookie()).toEqual([
      "hyori_share_gamma=tokenC; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200",
    ]);
    expect(database.writes).toEqual([]);
  } finally {
    storage.close();
  }
});

test("grant lookup and cookie retention remain bounded when many links are supplied", async () => {
  const cookies = Array.from(
    { length: 20 },
    (_, index) => `hyori_share_link${index}=token${index}`,
  );

  const database = new ReviewDatabase((query, variables) => {
    expect(query).toContain("FROM hc_grant");
    expect(variables.keys).toHaveLength(16);
    expect(variables.keys).not.toContain(digest("token0"));

    return [];
  });

  const storage = new ReviewStorage(config.storage);
  const runtime = new Runtime(config, { database, storage });

  const ctx = new RequestContext(
    runtime,
    new Request(config.origin, { headers: { Cookie: cookies.join("; ") } }),
  );

  try {
    const actor = await transact(database, (transaction) => ctx.actor(transaction));
    expect(actor.shareIds).toEqual([]);
    ctx.setShareCookie("new", "newToken");
    const updated = ctx.responseHeaders.getSetCookie();
    expect(updated.filter((cookie) => cookie.includes("Max-Age=0"))).toHaveLength(5);
    expect(updated.at(-1)).toContain("hyori_share_new=newToken");
  } finally {
    storage.close();
  }
});
