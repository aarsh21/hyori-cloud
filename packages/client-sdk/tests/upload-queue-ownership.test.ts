import { expect, test } from "bun:test";
import { createClient, createUploadQueue } from "@hyori-cloud/client-sdk";
import type { UploadCheckpoint } from "@hyori-cloud/client-sdk";
import { fakeAPI } from "#client-sdk-test/fake-api";

const file = () => new File(["1234567"], "hello.txt", { type: "text/plain", lastModified: 42 });

const checkpoint: UploadCheckpoint = {
  version: 1,
  uploadId: "upload_1",
  file: { name: "hello.txt", size: 7, type: file().type, lastModified: 42 },
};

async function until(predicate: () => boolean) {
  for (let index = 0; index < 5000; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Queue ownership transition did not settle");
}

test("a begin response received after disposal survives reconstruction and successor writes", async () => {
  const api = fakeAPI();
  const created = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();

  const sdk = createClient({
    fetch: async (url, init) => {
      const result = await api.fetch(url, init);
      created.resolve();
      await response.promise;

      return result;
    },
  });

  let stored: readonly UploadCheckpoint[] = [];

  const store = () => ({
    read: () => stored,
    write: (value: readonly UploadCheckpoint[]) => {
      stored = value;
    },
  });

  const old = createUploadQueue(sdk, store());
  old.add([file()], null);
  await created.promise;
  const row = old.getEntries()[0];

  if (row?.state !== "started") throw new Error("Upload did not begin");
  old.dispose();
  const successorCheckpoint = { ...checkpoint, uploadId: "successor-upload" };
  stored = [successorCheckpoint];
  const successor = createUploadQueue(sdk, store());
  response.resolve();
  await row.task.result.catch(() => undefined);
  await until(() => stored.some((item) => item.uploadId === checkpoint.uploadId));
  expect(row.task.getSnapshot().status).toBe("paused");
  expect(stored).toContainEqual(successorCheckpoint);
  expect(stored).toContainEqual(checkpoint);
  successor.add([], null);
  expect(stored).toHaveLength(2);
  successor.dispose();
  const reconstructed = createUploadQueue(sdk, store());
  expect(
    reconstructed
      .getEntries()
      .map((item) => item.id)
      .sort(),
  ).toEqual(["successor-upload", "upload_1"]);
  reconstructed.dispose();
  sdk.dispose();
});

test("slow restored cancellation blocks reselection and can be resumed after abort failure", async () => {
  const api = fakeAPI();
  const gate = Promise.withResolvers<void>();
  api.holdAbortUntil(gate.promise);
  api.failAbort(true);
  const sdk = createClient({ fetch: api.fetch });
  let stored: readonly UploadCheckpoint[] = [checkpoint];

  const queue = createUploadQueue(sdk, {
    read: () => stored,
    write: (value) => {
      stored = value;
    },
  });

  const cancellation = queue.cancel(checkpoint.uploadId);
  const repeated = queue.cancel(checkpoint.uploadId);
  expect(repeated).toBe(cancellation);
  expect(queue.getEntries()[0]).toMatchObject({ state: "interrupted", cancelling: true });
  expect(queue.getSummary()).toMatchObject({ active: 1, failed: 0 });
  queue.resume(checkpoint.uploadId, file());
  expect(queue.getEntries()[0]?.state).toBe("interrupted");
  expect(api.calls).not.toContain("uploads.status");
  gate.resolve();
  await expect(cancellation).rejects.toMatchObject({ code: "service.unavailable" });
  expect(queue.getEntries()[0]).toMatchObject({ state: "interrupted", cancelling: false });
  expect(stored).toHaveLength(1);
  api.failAbort(false);
  queue.resume(checkpoint.uploadId, file());
  await until(() => queue.getSummary().complete === 1);
  expect(queue.getEntries()[0]?.state).toBe("started");
  expect(queue.getSummary()).toMatchObject({ active: 0, failed: 0, complete: 1 });
  expect(stored).toEqual([]);
  expect(api.calls.filter((call) => call === "uploads.abort")).toHaveLength(1);
  queue.dispose();
  sdk.dispose();
});

test("a finalization settling after disposal reconciles completion without notifying UI observers", async () => {
  const api = fakeAPI();
  const finalizing = Promise.withResolvers<void>();
  const response = Promise.withResolvers<void>();

  const sdk = createClient({
    fetch: async (url, init) => {
      const before = api.completeCount;
      const result = await api.fetch(url, init);

      if (api.completeCount > before) {
        finalizing.resolve();
        await response.promise;
      }

      return result;
    },
  });

  let stored: readonly UploadCheckpoint[] = [];
  let reconciled = 0;
  let notifications = 0;

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
        reconciled += 1;
      },
    },
  );

  queue.add([file()], null);
  await finalizing.promise;
  const row = queue.getEntries()[0];

  if (row?.state !== "started") throw new Error("Upload did not start");
  queue.subscribe(() => {
    notifications += 1;
  });
  queue.dispose();
  const successorCheckpoint = { ...checkpoint, uploadId: "another-upload" };
  stored = [...stored, successorCheckpoint];
  const notificationsBeforeSettlement = notifications;
  response.resolve();
  await row.task.result;
  await until(() => reconciled === 1);
  expect(stored).toEqual([successorCheckpoint]);
  expect(notifications).toBe(notificationsBeforeSettlement);
  expect(row.task.getSnapshot().status).toBe("complete");
  sdk.dispose();
});

for (const outcome of ["aborted", "complete"] as const) {
  test(`a disposed restored cancellation removes only its ${outcome} checkpoint`, async () => {
    const api = fakeAPI();
    const gate = Promise.withResolvers<void>();
    api.holdAbortUntil(gate.promise);
    const sdk = createClient({ fetch: api.fetch });
    let stored: readonly UploadCheckpoint[] = [checkpoint];
    let reconciled = 0;
    let notifications = 0;

    const store = () => ({
      read: () => stored,
      write: (value: readonly UploadCheckpoint[]) => {
        stored = value;
      },
    });

    const old = createUploadQueue(sdk, store(), {
      onStored: () => {
        reconciled += 1;
      },
    });

    old.subscribe(() => {
      notifications += 1;
    });
    const cancellation = old.cancel(checkpoint.uploadId);
    old.dispose();
    const notificationsBeforeSettlement = notifications;
    const successorCheckpoint = { ...checkpoint, uploadId: "successor-upload" };
    stored = [...stored, successorCheckpoint];

    if (outcome === "complete") api.completeElsewhere();
    gate.resolve();
    await cancellation;
    expect(api.state).toBe(outcome);
    expect(stored).toEqual([successorCheckpoint]);
    expect(notifications).toBe(notificationsBeforeSettlement);
    expect(reconciled).toBe(outcome === "complete" ? 1 : 0);
    const reconstructed = createUploadQueue(sdk, store());
    expect(reconstructed.getEntries().map((entry) => entry.id)).toEqual(["successor-upload"]);
    reconstructed.dispose();
    sdk.dispose();
  });
}

test("a disposed restored cancellation cannot replace its successor's persisted checkpoints", async () => {
  const api = fakeAPI();
  const gate = Promise.withResolvers<void>();
  api.holdAbortUntil(gate.promise);
  api.failAbort(true);
  const sdk = createClient({ fetch: api.fetch });
  let stored: readonly UploadCheckpoint[] = [checkpoint];

  const store = () => ({
    read: () => stored,
    write: (value: readonly UploadCheckpoint[]) => {
      stored = value;
    },
  });

  const old = createUploadQueue(sdk, store());
  const cancellation = old.cancel(checkpoint.uploadId);
  old.dispose();
  const successorCheckpoint = { ...checkpoint, uploadId: "new-owner-upload" };
  stored = [successorCheckpoint];
  const successor = createUploadQueue(sdk, store());
  gate.resolve();
  await expect(cancellation).rejects.toMatchObject({ code: "service.unavailable" });
  expect(stored).toEqual([successorCheckpoint]);
  expect(successor.getEntries()).toHaveLength(1);
  successor.dispose();
  sdk.dispose();
});
