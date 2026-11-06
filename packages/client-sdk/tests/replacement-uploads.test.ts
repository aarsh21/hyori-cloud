import { describe, expect, test } from "bun:test";
import {
  createClient,
  createUploadQueue,
  decodeUploadCheckpoint,
  getUploadFailure,
  SDKError,
} from "@hyori-cloud/client-sdk";
import type { CheckpointStore, UploadCheckpoint, UploadEntry } from "@hyori-cloud/client-sdk";
import { fakeAPI } from "#client-sdk-test/fake-api";
import { replacementAPI } from "#client-sdk-test/replacement-fake-api";

const local = (name = "edited.docx", lastModified = 42) =>
  new File(["1234567"], name, { type: "application/test", lastModified });

const target = { id: "report_id", name: "report.docx" };
const intent = { kind: "replacement", name: target.name, targetId: target.id } as const;
const replacement = () => ({ file: local(), parentId: null, target });

function started(entry: UploadEntry | undefined) {
  if (entry?.state !== "started") throw new Error("Expected started queue entry");

  return entry;
}

function memoryStore() {
  let json = "[]";

  const store: CheckpointStore = {
    read: () => JSON.parse(json),
    write: (value) => {
      json = JSON.stringify(value);
    },
  };

  return { store, serialized: () => json };
}

async function until(predicate: () => boolean) {
  for (let index = 0; index < 1000; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Replacement queue transition did not settle");
}

describe("public replacement lifecycle with explicit protocol fakes, not real storage", () => {
  test("generic conflicts preserve intent without guessing a duplicate, revision or lease cause", () => {
    for (const message of ["Name exists", "Destination changed", "Transfer lease busy"]) {
      const error = { code: "resource.conflict" as const, message };
      expect(getUploadFailure(intent, error)).toBe("replacement-conflict");
      expect(getUploadFailure({ kind: "new", name: target.name }, error)).toBe("upload-conflict");
    }
  });

  test("queue persists local fingerprint separately from target and resumes missing parts without begin replay", async () => {
    const api = replacementAPI();
    const first = createClient({ fetch: api.fetch });
    const storage = memoryStore();
    const queue = createUploadQueue(first, storage.store);
    queue.replace(replacement());
    const row = started(queue.getEntries()[0]);
    expect(row).toMatchObject({ name: target.name, intent });
    expect(row.task.intent).toEqual(intent);
    row.task.subscribe(() => {
      if (row.task.getSnapshot().uploadedBytes === 3) queue.pause(row.id);
    });
    await expect(row.task.result).rejects.toHaveProperty("code", "SDK_CANCELLED");
    const saved = decodeUploadCheckpoint(JSON.parse(storage.serialized())[0]);
    expect(saved).toEqual({
      version: 2,
      uploadId: "replacement_1",
      file: { name: "edited.docx", size: 7, type: "application/test", lastModified: 42 },
      intent,
    });
    expect(storage.serialized()).not.toContain("slice");
    expect(api.begins).toEqual([
      {
        parentId: null,
        replaceId: target.id,
        name: target.name,
        size: 7,
        mimeType: "application/test",
      },
    ]);
    queue.dispose();
    first.dispose();

    const second = createClient({ fetch: api.fetch });
    const restored = createUploadQueue(second, storage.store);
    const recovered = restored.getEntries()[0]!;
    expect(recovered).toMatchObject({ state: "interrupted", intent, checkpoint: saved });

    for (const wrong of [
      local(target.name),
      local("edited.docx", 43),
      new File(["changed-size"], "edited.docx", { type: "application/test", lastModified: 42 }),
      new File(["1234567"], "edited.docx", { type: "other/type", lastModified: 42 }),
    ]) {
      restored.resume(recovered.id, wrong);
      expect(restored.getEntries()[0]).toMatchObject({
        state: "interrupted",
        intent,
        error: { code: "SDK_FILE_MISMATCH" },
      });
    }

    expect(() => {
      // @ts-expect-error Matching metadata alone is not consent to resume original bytes.
      second.uploads.resume({ checkpoint: saved, file: local(), confirmSameFile: false });
    }).toThrow(SDKError);
    expect(api.calls.filter((call) => call === "uploads.status")).toHaveLength(1);
    restored.resume(recovered.id, local());
    const resumed = started(restored.getEntries()[0]);
    expect(resumed.name).toBe(target.name);
    expect(resumed.intent).toEqual(intent);
    expect(resumed.task.intent).toEqual(intent);
    expect(await resumed.task.result).toMatchObject({ id: target.id, name: target.name });
    expect(api.begins).toHaveLength(1);
    expect(api.puts).toEqual(["replacement_1:1", "replacement_1:2", "replacement_1:3"]);
    expect(api.bytes).toBe("1234567");
    expect(storage.store.read()).toEqual([]);
    restored.dispose();
    second.dispose();
  });

  test("raw replacement retry preserves intent and committed bytes until successful completion", async () => {
    const api = replacementAPI();
    api.failComplete("service.unavailable");
    const sdk = createClient({ fetch: api.fetch });
    const task = sdk.uploads.replace(replacement(), { retryDelayMs: 0 });
    await expect(task.result).rejects.toHaveProperty("code", "service.unavailable");
    expect(task.intent).toEqual(intent);
    expect(getUploadFailure(task.intent, task.getSnapshot().error!)).toBe("replacement-failed");
    expect(api.bytes).toBe("original");
    api.failComplete(null);
    await task.retry();
    expect(api.begins).toHaveLength(1);
    expect(api.puts).toHaveLength(3);
    expect(task.intent).toEqual(intent);
    expect(api.bytes).toBe("1234567");
    sdk.dispose();
  });

  test("two explicit replacements retain the fake server's base-revision conflict on retry and reload", async () => {
    const api = replacementAPI();
    const sdk = createClient({ fetch: api.fetch });
    const storage = memoryStore();
    const queue = createUploadQueue(sdk, storage.store);
    queue.replace(replacement());
    queue.replace({
      ...replacement(),
      file: new File(["abcdefg"], "other.docx", { type: "application/test", lastModified: 42 }),
    });
    const rows = queue.getEntries().map(started);
    const outcomes = await Promise.allSettled(rows.map((row) => row.task.result));
    expect(outcomes.map((value) => value.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(api.revision).toBe(1);
    const failed = rows.find((row) => row.task.getSnapshot().status === "failed")!;
    expect(getUploadFailure(failed.intent, failed.task.getSnapshot().error!)).toBe(
      "replacement-conflict",
    );
    const committedBytes = api.bytes;
    queue.retry(failed.id);
    await expect(failed.task.result).rejects.toHaveProperty("code", "resource.conflict");
    expect(api.bytes).toBe(committedBytes);
    expect(api.begins).toHaveLength(2);
    const saved = decodeUploadCheckpoint(storage.store.read()[0]);
    expect(saved).toMatchObject({ version: 2, intent });
    queue.dispose();
    sdk.dispose();

    const next = createClient({ fetch: api.fetch });
    const restored = createUploadQueue(next, storage.store);
    restored.resume(saved.uploadId, local(saved.file.name));
    const resumed = started(restored.getEntries()[0]);
    await expect(resumed.task.result).rejects.toHaveProperty("code", "resource.conflict");
    expect(getUploadFailure(resumed.intent, resumed.task.getSnapshot().error!)).toBe(
      "replacement-conflict",
    );
    expect(api.bytes).toBe(committedBytes);
    expect(api.begins).toHaveLength(2);
    await restored.cancel(resumed.id);
    expect(storage.store.read()).toEqual([]);
    restored.dispose();
    next.dispose();
  });

  test("replacement abort failure keeps identity, checkpoint and bytes until cancellation retry", async () => {
    const api = replacementAPI();
    const gate = Promise.withResolvers<void>();
    api.holdPart(1, gate.promise);
    api.failAbort(true);
    const sdk = createClient({ fetch: api.fetch });
    const storage = memoryStore();
    const queue = createUploadQueue(sdk, storage.store);
    queue.replace(replacement());
    const row = started(queue.getEntries()[0]);
    await until(() => api.puts.length === 1);
    await expect(queue.cancel(row.id)).rejects.toHaveProperty("code", "service.unavailable");
    expect(row.task.getSnapshot()).toMatchObject({ status: "failed", intent: "cancel" });
    expect(row.task.intent).toEqual(intent);
    expect(storage.store.read()).toHaveLength(1);
    expect(api.bytes).toBe("original");
    api.failAbort(false);
    queue.retry(row.id);
    await expect(row.task.result).rejects.toHaveProperty("code", "SDK_CANCELLED");
    expect(row.task.getSnapshot().status).toBe("cancelled");
    expect(storage.store.read()).toEqual([]);
    expect(api.bytes).toBe("original");
    expect(api.begins).toHaveLength(1);
    gate.resolve();
    queue.dispose();
    sdk.dispose();
  });

  test("late replacement begin after disposal merges durable identity without clobbering successor checkpoints", async () => {
    const api = replacementAPI();
    const gate = Promise.withResolvers<void>();
    api.holdBegin(gate.promise);
    const sdk = createClient({ fetch: api.fetch });
    const storage = memoryStore();
    const queue = createUploadQueue(sdk, storage.store);
    queue.replace(replacement());
    const row = started(queue.getEntries()[0]);
    await until(() => api.begins.length === 1);
    queue.dispose();

    const other: UploadCheckpoint = {
      version: 1,
      uploadId: "unrelated",
      file: { name: "other", size: 0, type: "", lastModified: 0 },
    };

    storage.store.write([other]);
    const successor = createUploadQueue(sdk, storage.store);
    gate.resolve();
    await expect(row.task.result).rejects.toHaveProperty("code", "SDK_CANCELLED");
    await until(() => storage.store.read().length === 2);
    successor.add([], null);
    expect(storage.store.read()).toContainEqual(other);
    expect(storage.store.read()).toContainEqual({
      version: 2,
      uploadId: "replacement_1",
      file: { name: "edited.docx", size: 7, type: "application/test", lastModified: 42 },
      intent,
    });
    successor.dispose();
    const reconstructed = createUploadQueue(sdk, storage.store);
    expect(
      reconstructed.getEntries().find((entry) => entry.id === "replacement_1")?.intent,
    ).toEqual(intent);
    expect(api.bytes).toBe("original");
    reconstructed.dispose();
    sdk.dispose();
  });

  test("replacement waiting and reselected waiting keep intent under concurrency and detached checkpoint ownership", async () => {
    const api = replacementAPI();
    const gate = Promise.withResolvers<void>();
    api.holdPart(1, gate.promise);
    const sdk = createClient({ fetch: api.fetch });
    const storage = memoryStore();
    let queue = createUploadQueue(sdk, storage.store);
    queue.replace(replacement());
    await until(() => api.puts.length === 1);
    queue.dispose();
    const saved = decodeUploadCheckpoint(storage.store.read()[0]);
    queue = createUploadQueue(sdk, storage.store);
    queue.add([local("first-new"), local("second-new")], null);
    queue.resume(saved.uploadId, local());
    expect(queue.getEntries().find((entry) => entry.id === saved.uploadId)).toMatchObject({
      state: "waiting",
      intent,
    });
    queue.replace(replacement());
    expect(queue.getEntries().at(-1)).toMatchObject({ state: "waiting", intent });
    await until(() => api.begins.length === 3);
    expect(api.begins).toHaveLength(3);
    expect(storage.store.read()).toContainEqual(saved);
    queue.dismiss(saved.uploadId);
    expect(queue.getEntries().find((entry) => entry.id === saved.uploadId)).toBeDefined();
    queue.dispose();
    expect(storage.store.read()).toContainEqual(saved);
    const reconstructed = createUploadQueue(sdk, storage.store);
    expect(reconstructed.getEntries().find((entry) => entry.id === saved.uploadId)).toMatchObject({
      state: "interrupted",
      intent,
    });
    gate.resolve();
    reconstructed.dispose();
    sdk.dispose();
  });

  test("v1 normal checkpoints still resume but remain explicitly unknown intent; ordinary picked names never imply replacement", async () => {
    const api = fakeAPI();
    const sdk = createClient({ fetch: api.fetch });

    const saved: UploadCheckpoint = {
      version: 1,
      uploadId: "upload_1",
      file: { name: "edited.docx", size: 7, type: "application/test", lastModified: 42 },
    };

    const task = sdk.uploads.resume({ checkpoint: saved, file: local(), confirmSameFile: true });
    expect(task.intent).toEqual({ kind: "legacy", name: "edited.docx" });
    await task.result;
    expect(api.beginCount).toBe(0);
    expect(
      getUploadFailure(task.intent, {
        code: "resource.conflict",
        message: "Unknown legacy conflict",
      }),
    ).toBe("upload-failed");
    const fresh = sdk.uploads.start({ file: local(target.name), parentId: null });
    expect(fresh.intent).toEqual({ kind: "new", name: target.name });
    expect(getUploadFailure(fresh.intent, { code: "resource.conflict", message: "Exists" })).toBe(
      "upload-conflict",
    );
    await fresh.result;
    sdk.dispose();
  });

  test("legacy start replaceId remains supported and records explicit replacement metadata", async () => {
    const api = replacementAPI();
    const sdk = createClient({ fetch: api.fetch });
    const task = sdk.uploads.start({ file: local(), parentId: null, replaceId: target.id });
    await task.result;
    expect(task.intent).toEqual({ ...intent, name: "edited.docx" });
    expect(task.getSnapshot().checkpoint).toMatchObject({
      version: 2,
      file: { name: "edited.docx" },
      intent: { ...intent, name: "edited.docx" },
    });
    sdk.dispose();
  });

  test("malformed versions, source fingerprints and replacement metadata are rejected before network I/O", () => {
    const api = replacementAPI();
    const sdk = createClient({ fetch: api.fetch });

    const base = {
      version: 2,
      uploadId: "replacement_1",
      file: { name: "edited.docx", size: 7, type: "application/test", lastModified: 42 },
      intent,
    };

    const bad = [
      { ...base, version: 3 },
      { ...base, intent: undefined },
      { ...base, intent: { ...intent, targetId: "" } },
      { ...base, intent: { ...intent, name: "" } },
      { ...base, intent: { kind: "legacy", name: "edited.docx" } },
      { ...base, intent: { kind: "replacement", name: "report.docx" } },
      { ...base, file: { ...base.file, size: -1 } },
      { ...base, file: { ...base.file, lastModified: Infinity } },
      { ...base, version: 1 },
      { ...base, file: { ...base.file, bytes: [1, 2, 3] } },
    ];

    for (const checkpoint of bad) {
      expect(() => decodeUploadCheckpoint(checkpoint)).toThrow();
      expect(() => {
        // @ts-expect-error Unknown persisted checkpoints must be validated by the runtime boundary.
        sdk.uploads.resume({ checkpoint, file: local(), confirmSameFile: true });
      }).toThrow(SDKError);
    }

    expect(() => sdk.uploads.replace({ ...replacement(), target: { id: "", name: "" } })).toThrow(
      SDKError,
    );
    // @ts-expect-error Raw replacement cannot silently fall back to creating a new file.
    expect(() => sdk.uploads.replace({ file: local(), parentId: null })).toThrow(SDKError);
    expect(api.calls).toEqual([]);
    sdk.dispose();
  });
});
