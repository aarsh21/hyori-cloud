import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import { fakeAPI } from "#client-sdk-test/fake-api";

for (const [status, code] of [
  [409, "resource.conflict"],
  [403, "access.denied"],
] as const) {
  test(`binary part ${status} preserves the declared ${code} failure and checkpoint`, async () => {
    const api = fakeAPI();
    let reject = true;
    let puts = 0;

    const client = createClient({
      fetch: async (url, init) => {
        if (String(url).includes("/binary/")) {
          puts += 1;

          if (reject)
            return Response.json(
              { ok: false, error: { code, message: "Synthetic rejection" } },
              { status },
            );
        }

        return api.fetch(url, init);
      },
    });

    const task = client.uploads.start(
      { parentId: null, file: new File(["1234567"], "report.txt") },
      { retryDelayMs: 0 },
    );

    try {
      await expect(task.result).rejects.toMatchObject({ code });
      expect(puts).toBe(1);
      expect(task.getSnapshot().checkpoint).not.toBeNull();
      expect(api.beginCount).toBe(1);
      expect(api.completeCount).toBe(0);
      reject = false;
      await task.retry();
      expect(api.beginCount).toBe(1);
      expect(api.completeCount).toBe(1);
    } finally {
      task.dispose();
      client.dispose();
    }
  });
}

test("transient binary HTTP failures keep bounded part retries", async () => {
  const api = fakeAPI();
  let failures = 0;

  const client = createClient({
    fetch: async (url, init) => {
      if (String(url).includes("/binary/") && failures++ === 0)
        return new Response("Temporary gateway failure", { status: 503 });

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start(
    { parentId: null, file: new File(["1234567"], "report.txt") },
    { retryDelayMs: 0 },
  );

  try {
    await task.result;
    expect(failures).toBe(4);
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(1);
  } finally {
    task.dispose();
    client.dispose();
  }
});
