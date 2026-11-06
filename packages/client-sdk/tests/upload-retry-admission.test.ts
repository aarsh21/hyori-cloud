import { expect, test } from "bun:test";
import { createClient, createUploadQueue, SDKError } from "@hyori-cloud/client-sdk";
import type { UploadSnapshot, UploadTask } from "@hyori-cloud/client-sdk";
import { entry } from "#client-sdk-test/fake-api";

function controlled(name: string) {
  let result = Promise.withResolvers<typeof entry>();
  let retryCount = 0;

  let snapshot: UploadSnapshot = {
    status: "pending",
    uploadedBytes: 0,
    totalBytes: 7,
    checkpoint: null,
    error: null,
    file: null,
  };

  const listeners = new Set<() => void>();

  const publish = (next: UploadSnapshot) => {
    snapshot = next;

    for (const listener of listeners) listener();
  };

  const task: UploadTask = {
    intent: { kind: "new", name },
    get result() {
      return result.promise;
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    pause() {
      publish({ ...snapshot, status: "paused", error: null, file: null });
    },
    async cancel() {
      publish({ ...snapshot, status: "cancelled", error: null, file: null });
    },
    retry() {
      retryCount += 1;
      result = Promise.withResolvers<typeof entry>();
      publish({ ...snapshot, status: "pending", error: null, file: null });

      return result.promise;
    },
    dispose() {
      listeners.clear();
    },
  };

  return {
    task,
    get retryCount() {
      return retryCount;
    },
    fail() {
      const error = new SDKError("SDK_TRANSPORT", "Synthetic failure");
      publish({ ...snapshot, status: "failed", error, file: null });
      result.reject(error);
    },
    complete() {
      publish({
        ...snapshot,
        status: "complete",
        file: entry,
        error: null,
        uploadedBytes: 7,
        checkpoint: {
          version: 2,
          uploadId: `upload_${name}`,
          intent: { kind: "new", name },
          file: { name, size: 7, type: "", lastModified: 0 },
        },
      });
      result.resolve(entry);
    },
  };
}

test("a retry waiting for a queue slot is observable without starting a third transfer", async () => {
  const client = createClient();
  const tasks: ReturnType<typeof controlled>[] = [];
  client.uploads.start = (input) => {
    const next = controlled(input.file.name);
    tasks.push(next);

    return next.task;
  };

  const queue = createUploadQueue(client, { read: () => [], write: () => undefined });

  try {
    queue.add(
      ["a", "b", "c"].map((name) => new File(["1234567"], name)),
      null,
    );
    const first = queue.getEntries()[0]!;
    tasks[0]!.fail();
    expect(tasks).toHaveLength(3);
    queue.retry(first.id);
    queue.retry(first.id);
    expect(queue.getEntries()[0]).toMatchObject({ state: "started", retryQueued: true });
    expect(queue.getSummary()).toMatchObject({ active: 3, failed: 0 });
    expect(tasks[0]!.retryCount).toBe(0);
    tasks[1]!.complete();
    expect(tasks[0]!.retryCount).toBe(1);
    expect(queue.getEntries()[0]).toMatchObject({ retryQueued: false });
    tasks[0]!.complete();
    tasks[2]!.complete();
    await Promise.resolve();
  } finally {
    queue.dispose();
    client.dispose();
  }
});

test("pausing a queued retry withdraws its admission and publishes that state", async () => {
  const client = createClient();
  const tasks: ReturnType<typeof controlled>[] = [];
  client.uploads.start = (input) => {
    const next = controlled(input.file.name);
    tasks.push(next);

    return next.task;
  };

  const queue = createUploadQueue(client, { read: () => [], write: () => undefined });

  try {
    queue.add(
      ["a", "b", "c"].map((name) => new File(["1234567"], name)),
      null,
    );
    const first = queue.getEntries()[0]!;
    tasks[0]!.fail();
    queue.retry(first.id);
    expect(queue.getEntries()[0]).toMatchObject({ retryQueued: true });
    queue.pause(first.id);
    expect(queue.getEntries()[0]).toMatchObject({ retryQueued: false });
    tasks[1]!.complete();
    tasks[2]!.complete();
    await Promise.resolve();
    expect(tasks[0]!.retryCount).toBe(0);
  } finally {
    queue.dispose();
    client.dispose();
  }
});
