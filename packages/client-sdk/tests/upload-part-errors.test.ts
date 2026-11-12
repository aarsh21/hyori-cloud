import { expect, spyOn, test } from "bun:test";
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

test("a restart lasting 3.5 seconds retries the same upload and exact part bytes automatically", async () => {
  const api = fakeAPI();
  let failedAt: number | null = null;
  const attempts: { at: number; uploadId: unknown; partNumber: unknown }[] = [];
  const bytes: string[] = [];

  const client = createClient({
    fetch: async (url, init) => {
      if (String(url).includes("/binary/")) {
        bytes.push(await new Response(init?.body).text());

        // Lose the first acknowledgement after storage accepted it.
        if (failedAt === null) {
          await api.fetch(url, init);
          failedAt = performance.now();
          throw new TypeError("backend crashed after writing part");
        }
      } else {
        const rpc = await new Response(init?.body).json();

        if (rpc.operation === "uploads.part" && rpc.input.partNumber === 1) {
          attempts.push({ at: performance.now(), ...rpc.input });

          if (failedAt !== null && performance.now() - failedAt < 3500)
            return Response.json(
              { ok: false, error: { code: "service.unavailable", message: "Restarting" } },
              { status: 503 },
            );
        }
      }

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start({
    parentId: null,
    file: new File(["1234567"], "report.txt"),
  });

  try {
    await task.result;
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(1);
    expect(attempts.map(({ uploadId, partNumber }) => ({ uploadId, partNumber }))).toEqual(
      Array.from({ length: 4 }, () => ({ uploadId: "upload_1", partNumber: 1 })),
    );
    expect(attempts[1]!.at - attempts[0]!.at).toBeGreaterThanOrEqual(950);
    expect(attempts[2]!.at - attempts[1]!.at).toBeGreaterThanOrEqual(1950);
    expect(attempts[3]!.at - attempts[2]!.at).toBeGreaterThanOrEqual(3950);
    expect(bytes).toEqual(["123", "123", "456", "7"]);
    expect(
      new TextDecoder().decode(
        Uint8Array.from([...api.stored.values()].flatMap((part) => [...part])),
      ),
    ).toBe("1234567");
    expect(task.getSnapshot().uploadedBytes).toBe(7);
  } finally {
    task.dispose();
    client.dispose();
  }
}, 12000);

test("an ongoing unavailable RPC exhausts the bounded retry budget without another begin", async () => {
  const api = fakeAPI();
  let parts = 0;

  const client = createClient({
    fetch: async (url, init) => {
      if (!String(url).includes("/binary/")) {
        const rpc = await new Response(init?.body).json();

        if (rpc.operation === "uploads.part") {
          parts++;

          return new Response("Gateway unavailable", { status: 502 });
        }
      }

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start(
    { parentId: null, file: new File(["1234567"], "report.txt") },
    { retryDelayMs: 0 },
  );

  try {
    await expect(task.result).rejects.toMatchObject({ code: "service.unavailable" });
    expect(parts).toBe(4);
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(0);
    expect(task.getSnapshot().checkpoint?.uploadId).toBe("upload_1");
  } finally {
    task.dispose();
    client.dispose();
  }
});

test("explicit busy refusals wait across begin, part and complete without replaying accepted work", async () => {
  const api = fakeAPI();
  const refused = new Set<string>();
  const waits: number[] = [];
  const timer = globalThis.setTimeout;

  const timers = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    waits.push(Number(ms));

    return timer(callback, 0, ...args);
  });

  const client = createClient({
    fetch: async (url, init) => {
      const phase = String(url).includes("/binary/")
        ? String(url)
        : (await new Response(init?.body).json()).operation;

      if (
        (phase === "uploads.begin" ||
          phase === "uploads.complete" ||
          phase.includes("/binary/1")) &&
        !refused.has(phase)
      ) {
        refused.add(phase);

        return Response.json(
          { ok: false, error: { code: "uploads.busy", message: "Busy" } },
          { status: 409 },
        );
      }

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start({ parentId: null, file: new File(["1234567"], "report.txt") });

  try {
    await task.result;
    expect(waits).toEqual([5000, 5000, 5000]);
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(1);
    expect(
      new TextDecoder().decode(
        Uint8Array.from([...api.stored.values()].flatMap((part) => [...part])),
      ),
    ).toBe("1234567");
    expect(task.getSnapshot()).toMatchObject({ status: "complete", uploadedBytes: 7 });
  } finally {
    task.dispose();
    client.dispose();
    timers.mockRestore();
  }
});

test("busy waiting is bounded to the three-minute lease plus fifteen seconds", async () => {
  const api = fakeAPI();
  const waits: number[] = [];
  let clock = 0;
  let puts = 0;
  const timer = globalThis.setTimeout;
  const now = spyOn(performance, "now").mockImplementation(() => clock);

  const timers = spyOn(globalThis, "setTimeout").mockImplementation((callback, ms, ...args) => {
    waits.push(Number(ms));
    clock += Number(ms);

    return timer(callback, 0, ...args);
  });

  const client = createClient({
    fetch: async (url, init) => {
      if (String(url).includes("/binary/")) {
        puts++;

        return Response.json(
          { ok: false, error: { code: "uploads.busy", message: "Busy" } },
          { status: 409 },
        );
      }

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start({ parentId: null, file: new File(["1234567"], "report.txt") });

  try {
    await expect(task.result).rejects.toMatchObject({ code: "uploads.busy" });
    expect(waits).toEqual(Array.from({ length: 39 }, () => 5000));
    expect(puts).toBe(40);
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(0);
    expect(task.getSnapshot()).toMatchObject({
      status: "failed",
      checkpoint: { uploadId: "upload_1" },
    });
  } finally {
    task.dispose();
    client.dispose();
    timers.mockRestore();
    now.mockRestore();
  }
});

test("pausing interrupts busy waiting without another part request", async () => {
  const api = fakeAPI();
  const refused = Promise.withResolvers<void>();
  let puts = 0;

  const client = createClient({
    fetch: async (url, init) => {
      if (String(url).includes("/binary/")) {
        puts++;
        refused.resolve();

        return Response.json(
          { ok: false, error: { code: "uploads.busy", message: "Busy" } },
          { status: 409 },
        );
      }

      return api.fetch(url, init);
    },
  });

  const task = client.uploads.start({ parentId: null, file: new File(["1234567"], "report.txt") });

  try {
    await refused.promise;
    task.pause();
    await expect(task.result).rejects.toMatchObject({ code: "SDK_CANCELLED" });
    expect(puts).toBe(1);
    expect(task.getSnapshot()).toMatchObject({
      status: "paused",
      checkpoint: { uploadId: "upload_1" },
    });
  } finally {
    task.dispose();
    client.dispose();
  }
});

for (const phase of ["uploads.begin", "uploads.complete"]) {
  test(`an ambiguous ${phase} acknowledgement is not automatically replayed`, async () => {
    const api = fakeAPI();

    const client = createClient({
      fetch: async (url, init) => {
        const response = await api.fetch(url, init);

        if (!String(url).includes("/binary/")) {
          const rpc = await new Response(init?.body).json();

          if (rpc.operation === phase) throw new TypeError("Backend crashed after acceptance");
        }

        return response;
      },
    });

    const task = client.uploads.start(
      { parentId: null, file: new File(["1234567"], "report.txt") },
      { retryDelayMs: 0 },
    );

    try {
      await expect(task.result).rejects.toMatchObject({ code: "SDK_TRANSPORT" });
      expect(api.beginCount).toBe(1);
      expect(api.completeCount).toBe(phase === "uploads.complete" ? 1 : 0);
      expect(task.getSnapshot().checkpoint?.uploadId ?? null).toBe(
        phase === "uploads.complete" ? "upload_1" : null,
      );
    } finally {
      task.dispose();
      client.dispose();
    }
  });
}
