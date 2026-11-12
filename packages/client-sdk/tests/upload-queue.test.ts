import { describe, expect, spyOn, test } from "bun:test";
import { createClient, createUploadQueue, SDKError, UploadSnapshot } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
import type { UploadCheckpoint, UploadTask } from "@hyori-cloud/client-sdk";
import { entry, fakeAPI } from "#client-sdk-test/fake-api";

const file = (name = "hello.txt") =>
  new File(["1234567"], name, { type: "text/plain", lastModified: 42 });

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Test condition did not arrive");
}

function controlledTask(name: string) {
  let snapshot: UploadSnapshot = {
    status: "pending",
    uploadedBytes: 0,
    totalBytes: 7,
    checkpoint: null,
    error: null,
    file: null,
  };

  const listeners = new Set<() => void>();
  let resolve: (value: typeof entry) => void = () => undefined;
  let reject: (error: SDKError) => void = () => undefined;

  const promise = new Promise<typeof entry>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  void promise.catch(() => undefined);

  const publish = (patch: Partial<UploadSnapshot>) => {
    snapshot = Schema.decodeUnknownSync(UploadSnapshot)({ ...snapshot, ...patch });

    for (const listener of listeners) listener();
  };

  const task: UploadTask = {
    intent: { kind: "new", name },
    result: promise,
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    pause: () => {
      publish({ status: "paused" });
      reject(new SDKError("SDK_CANCELLED", "Paused"));
    },
    cancel: async () => {
      publish({ status: "cancelled" });
      reject(new SDKError("SDK_CANCELLED", "Cancelled"));
    },
    retry: async () => {
      publish({ status: "pending" });

      return promise;
    },
    dispose: () => {
      if (snapshot.status !== "complete" && snapshot.status !== "cancelled") {
        publish({ status: "paused" });
        reject(new SDKError("SDK_CANCELLED", "Disposed"));
      }

      listeners.clear();
    },
  };

  return {
    task,
    complete: () => {
      const result = { ...entry, name };
      publish({
        status: "complete",
        file: result,
        checkpoint: {
          version: 1,
          uploadId: "upload_fake",
          file: { name, size: 7, type: "text/plain", lastModified: 42 },
        },
      });
      resolve(result);
    },
  };
}

describe("public vanilla upload queue with explicit task fakes", () => {
  test("bounds concurrent admission and pumps queued files after a terminal transition", async () => {
    const sdk = createClient();
    const controlled: ReturnType<typeof controlledTask>[] = [];
    sdk.uploads.start = (input) => {
      const next = controlledTask(input.file.name);
      controlled.push(next);

      return next.task;
    };

    const queue = createUploadQueue(sdk, { read: () => [], write: () => undefined });
    queue.add([file("a"), file("b"), file("c")], null);
    expect(controlled).toHaveLength(2);
    expect(queue.getSummary().active).toBe(3);
    controlled[0]!.complete();
    expect(controlled).toHaveLength(3);
    controlled[1]!.complete();
    controlled[2]!.complete();
    await Promise.resolve();
    expect(queue.getSummary().complete).toBe(3);
    queue.clearFinished();
    expect(queue.getEntries()).toEqual([]);
    queue.dispose();
    sdk.dispose();
  });

  test("retains persisted checkpoints until slow abort and terminal status confirmation finish", async () => {
    const api = fakeAPI();
    api.holdNextPart();
    const sdk = createClient({ fetch: api.fetch });
    const abortGate = Promise.withResolvers<void>();
    const confirmationGate = Promise.withResolvers<void>();
    api.holdAbortUntil(abortGate.promise);
    api.holdAbortConfirmationUntil(confirmationGate.promise);
    let stored: readonly UploadCheckpoint[] = [];

    const queue = createUploadQueue(sdk, {
      read: () => [],
      write: (value) => {
        stored = value;
      },
    });

    queue.add([file()], null);
    await until(() => api.calls.includes("PUT:1"));
    const row = queue.getEntries()[0];

    if (row?.state !== "started") throw new Error("Upload did not start");
    const states: string[] = [];
    row.task.subscribe(() => states.push(row.task.getSnapshot().status));
    const cancelled = queue.cancel(row.id);
    const alsoCancelled = queue.cancel(row.id);
    await until(() => api.calls.includes("uploads.abort"));
    expect(row.task.getSnapshot().status).toBe("cancelling");
    expect(queue.getSummary().active).toBe(1);
    expect(stored.map((checkpoint) => checkpoint.uploadId)).toEqual(["upload_1"]);
    queue.dismiss(row.id);
    queue.clearFinished();
    queue.retry(row.id);
    expect(queue.getEntries()).toHaveLength(1);
    abortGate.resolve();
    await until(() => api.state === "aborted");
    expect(row.task.getSnapshot().status).toBe("cancelling");
    expect(stored).toHaveLength(1);
    expect(states).not.toContain("cancelled");
    confirmationGate.resolve();
    await Promise.all([cancelled, alsoCancelled]);
    expect(api.calls.filter((operation) => operation === "uploads.abort")).toHaveLength(1);
    expect(row.task.getSnapshot().status).toBe("cancelled");
    expect(queue.getSummary().active).toBe(0);
    expect(stored).toEqual([]);
    queue.dispose();
    sdk.dispose();
  });

  test("a failed active abort publishes failure but keeps its checkpoint for a later cancellation", async () => {
    const api = fakeAPI();
    api.holdNextPart();
    const sdk = createClient({ fetch: api.fetch });
    api.failAbort(true);
    let stored: readonly UploadCheckpoint[] = [];

    const queue = createUploadQueue(sdk, {
      read: () => [],
      write: (value) => {
        stored = value;
      },
    });

    queue.add([file()], null);
    await until(() => api.calls.includes("PUT:1"));
    const row = queue.getEntries()[0];

    if (row?.state !== "started") throw new Error("Upload did not start");
    const states: string[] = [];
    queue.subscribe(() => states.push(row.task.getSnapshot().status));
    await expect(queue.cancel(row.id)).rejects.toHaveProperty("code", "service.unavailable");
    expect(states).toContain("cancelling");
    expect(states).toContain("failed");
    expect(states).not.toContain("cancelled");
    expect(stored).toHaveLength(1);
    expect(row.task.getSnapshot().error).toHaveProperty("message", "Abort unavailable");
    expect(row.task.getSnapshot()).toMatchObject({ status: "failed", intent: "cancel" });
    queue.dismiss(row.id);
    expect(queue.getEntries()).toHaveLength(1);
    api.failAbort(false);
    queue.retry(row.id);
    await expect(row.task.result).rejects.toHaveProperty("code", "SDK_CANCELLED");
    expect(row.task.getSnapshot().status).toBe("cancelled");
    expect(stored).toEqual([]);
    expect(api.beginCount).toBe(1);
    queue.dispose();
    sdk.dispose();
  });

  test("retry reconciles a completed upload when abort conflicts with another client's commit", async () => {
    const api = fakeAPI();
    api.holdNextPart();
    api.failAbort(true);
    const sdk = createClient({ fetch: api.fetch });
    let stored: readonly UploadCheckpoint[] = [];
    let reconciled = 0;

    const queue = createUploadQueue(
      sdk,
      {
        read: () => [],
        write: (value) => {
          stored = value;
        },
      },
      {
        onStored: () => {
          reconciled++;
        },
      },
    );

    queue.add([file()], null);
    await until(() => api.calls.includes("PUT:1"));
    const row = queue.getEntries()[0];

    if (row?.state !== "started") throw new Error("Upload did not start");
    await expect(queue.cancel(row.id)).rejects.toHaveProperty("code", "service.unavailable");
    expect(stored).toHaveLength(1);
    api.failAbort(false);
    api.completeElsewhere();
    queue.retry(row.id);
    expect(await row.task.result).toEqual(entry);
    expect(row.task.getSnapshot().status).toBe("complete");
    expect(stored).toEqual([]);
    expect(reconciled).toBe(1);
    expect(api.beginCount).toBe(1);
    queue.dispose();
    sdk.dispose();
  });

  test("disposal during a pending cancellation retains a checkpoint a new queue can recover", async () => {
    const api = fakeAPI();
    api.holdNextPart();
    const sdk = createClient({ fetch: api.fetch });
    const gate = Promise.withResolvers<void>();
    api.holdAbortUntil(gate.promise);
    let stored: readonly UploadCheckpoint[] = [];

    const store = {
      read: () => stored,
      write: (value: readonly UploadCheckpoint[]) => {
        stored = value;
      },
    };

    const queue = createUploadQueue(sdk, store);
    queue.add([file()], null);
    await until(() => api.calls.includes("PUT:1"));
    const cancelled = queue.cancel(queue.getEntries()[0]!.id);
    void cancelled.catch(() => undefined);
    await until(() => api.calls.includes("uploads.abort"));
    queue.dispose();
    sdk.dispose();
    expect(stored).toHaveLength(1);
    gate.resolve();
    await expect(cancelled).rejects.toHaveProperty("code", "SDK_CANCELLED");
    expect(stored).toHaveLength(1);
    const restarted = createClient({ fetch: api.fetch });
    const restored = createUploadQueue(restarted, store);
    const row = restored.getEntries()[0];
    expect(row?.state).toBe("interrupted");
    expect(row?.id).toBe("upload_1");
    await restored.cancel(row!.id);
    expect(api.state).toBe("aborted");
    expect(stored).toEqual([]);
    restored.dispose();
    restarted.dispose();
  });

  test("interrupted cancel failures notify subscribers with the retained checkpoint and error", async () => {
    const api = fakeAPI();
    api.failAbort(true);
    const sdk = createClient({ fetch: api.fetch });

    const checkpoint: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_1",
      file: { name: "hello.txt", size: 7, type: "text/plain", lastModified: 42 },
    };

    const failure = { code: "service.unavailable" as const, message: "Abort unavailable" };
    let stored: readonly UploadCheckpoint[] = [checkpoint];

    const queue = createUploadQueue(sdk, {
      read: () => stored,
      write: (value) => {
        stored = value;
      },
    });

    const seen: ReturnType<typeof queue.getEntries>[] = [];
    queue.subscribe(() => seen.push(queue.getEntries()));
    await expect(queue.cancel(checkpoint.uploadId)).rejects.toEqual(failure);
    expect(seen).toHaveLength(2);
    expect(seen[0]?.[0]).toMatchObject({ state: "interrupted", cancelling: true, error: null });
    expect(seen[1]?.[0]).toEqual({
      state: "interrupted",
      id: checkpoint.uploadId,
      checkpoint,
      intent: { kind: "legacy", name: "hello.txt" },
      cancelling: false,
      error: failure,
    });
    expect(stored).toEqual([checkpoint]);
    queue.dispose();
    sdk.dispose();
  });

  test("a restored checkpoint reconciles an abort conflict with an already committed upload", async () => {
    const api = fakeAPI();
    api.completeElsewhere();
    const sdk = createClient({ fetch: api.fetch });

    const checkpoint: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_1",
      file: { name: "hello.txt", size: 7, type: "text/plain", lastModified: 42 },
    };

    let stored: readonly UploadCheckpoint[] = [checkpoint];
    let reconciled = 0;

    const queue = createUploadQueue(
      sdk,
      {
        read: () => stored,
        write: (value) => {
          stored = value;
        },
      },
      {
        onStored: () => {
          reconciled++;
        },
      },
    );

    await queue.cancel(checkpoint.uploadId);
    expect(queue.getEntries()).toEqual([]);
    expect(stored).toEqual([]);
    expect(reconciled).toBe(1);
    expect(api.calls).toEqual(["uploads.abort", "uploads.status"]);
    queue.dispose();
    sdk.dispose();
  });

  test("classifies pending uploads by this browser's validated checkpoints without inferring from names", async () => {
    const checkpoint: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_saved",
      file: { name: "same.txt", size: 7, type: "text/plain", lastModified: 42 },
    };

    const sdk = createClient({
      fetch: async () =>
        Response.json({
          ok: true,
          value: {
            items: ["upload_saved", "upload_elsewhere"].map((uploadId) => ({
              uploadId,
              name: "same.txt",
              size: 7,
              expiresAt: "2026-11-13T00:00:00Z",
            })),
            cursor: null,
          },
        }),
    });

    const queue = createUploadQueue(sdk, {
      read: () => [checkpoint, { version: "invalid", uploadId: "upload_elsewhere" }],
      write: () => undefined,
    });

    const page = await queue.listPending({ cursor: null, limit: 100 });
    expect(page.items.map((upload) => upload.checkpoint)).toEqual([checkpoint, null]);
    expect(page.cursor).toBeNull();
    queue.dispose();
    sdk.dispose();
  });

  test("pending discovery removes an interrupted upload cancelled by another client", async () => {
    const api = fakeAPI();

    const fetch: typeof api.fetch = async (url, init) => {
      const request = JSON.parse(String(init?.body));

      if (request.operation === "uploads.pending")
        return Response.json({ ok: true, value: { items: [], cursor: null } });

      return api.fetch(url, init);
    };

    const sdk = createClient({ fetch });
    const other = createClient({ fetch });

    const checkpoint: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_1",
      file: { name: "hello.txt", size: 7, type: "text/plain", lastModified: 42 },
    };

    let stored: readonly UploadCheckpoint[] = [checkpoint];

    const queue = createUploadQueue(sdk, {
      read: () => stored,
      write: (value) => {
        stored = value;
      },
    });

    // Absence from a page alone cannot discard a live upload.
    await queue.listPending({ cursor: null, limit: 100 });
    expect(queue.getEntries()).toHaveLength(1);
    expect(stored).toEqual([checkpoint]);
    await other.rpc.uploads.abort({ uploadId: checkpoint.uploadId });
    await queue.listPending({ cursor: null, limit: 100 });
    expect(queue.getEntries()).toEqual([]);
    expect(stored).toEqual([]);
    queue.dispose();
    sdk.dispose();
    other.dispose();
  });

  for (const code of [
    "SDK_TRANSPORT",
    "service.unavailable",
    "uploads.busy",
    "resource.notFound",
  ] as const)
    test(`pending discovery only forgets explicitly gone uploads, not ${code}`, async () => {
      const sdk = createClient();

      spyOn(sdk.rpc.uploads, "pending").mockImplementation(async () => ({
        items: [],
        cursor: "another-page",
      }));
      spyOn(sdk.rpc.uploads, "status").mockImplementation(async () => {
        throw code === "SDK_TRANSPORT"
          ? new SDKError(code, "Probe failure")
          : { code, message: "Probe failure" };
      });

      const checkpoint: UploadCheckpoint = {
        version: 1,
        uploadId: "upload_saved",
        file: { name: "hello.txt", size: 7, type: "text/plain", lastModified: 42 },
      };

      let stored: readonly UploadCheckpoint[] = [checkpoint];

      const queue = createUploadQueue(sdk, {
        read: () => stored,
        write: (value) => {
          stored = value;
        },
      });

      await queue.listPending({ cursor: null, limit: 1 });
      expect(queue.getEntries()).toHaveLength(code === "resource.notFound" ? 0 : 1);
      expect(stored).toEqual(code === "resource.notFound" ? [] : [checkpoint]);
      queue.dispose();
      sdk.dispose();
    });

  test("keeps queued resume checkpoints, validates metadata once, and pauses owned tasks on disposal", () => {
    const sdk = createClient();
    const original = file();

    const checkpoint: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_saved",
      file: {
        name: original.name,
        size: original.size,
        type: original.type,
        lastModified: original.lastModified,
      },
    };

    let stored: readonly UploadCheckpoint[] = [];
    const controlled: ReturnType<typeof controlledTask>[] = [];
    sdk.uploads.start = (input) => {
      const next = controlledTask(input.file.name);
      controlled.push(next);

      return next.task;
    };

    const queue = createUploadQueue(sdk, {
      read: () => [{ version: "wrong" }, checkpoint, checkpoint],
      write: (value) => {
        stored = value;
      },
    });

    expect(queue.getEntries()).toHaveLength(1);
    queue.add([file("a"), file("b")], null);
    queue.resume(checkpoint.uploadId, original);
    expect(controlled).toHaveLength(2);
    expect(stored.map((value) => value.uploadId)).toContain(checkpoint.uploadId);
    queue.dispose();
    expect(controlled.every((value) => value.task.getSnapshot().status === "paused")).toBe(true);
    expect(stored.map((value) => value.uploadId)).toContain(checkpoint.uploadId);
    expect(() => queue.add([original], null)).toThrow("disposed");
    sdk.dispose();
  });
});
