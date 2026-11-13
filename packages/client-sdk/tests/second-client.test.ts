import { describe, expect, test } from "bun:test";
import { createClient, SDKError, UploadSnapshot } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
import { decodeUploadCheckpoint } from "@hyori-cloud/client-sdk";
import { fakeAPI } from "#client-sdk-test/fake-api";

const localFile = () =>
  new File([new Uint8Array([1, 2, 3, 4, 5, 6, 7])], "hello.txt", {
    type: "text/plain",
    lastModified: 42,
  });

async function until(predicate: () => boolean) {
  for (let index = 0; index < 100; index++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }

  throw new Error("Test condition did not arrive");
}

describe("public non-React SDK with explicit fake API (not real storage evidence)", () => {
  test("runtime workflow schema rejects contradictory lifecycle states", () => {
    const fields = { uploadedBytes: 0, totalBytes: 7, checkpoint: null, error: null, file: null };
    expect(Schema.is(UploadSnapshot)({ ...fields, status: "failed" })).toBe(false);
    expect(Schema.is(UploadSnapshot)({ ...fields, status: "complete" })).toBe(false);
    expect(
      Schema.is(UploadSnapshot)({
        ...fields,
        status: "pending",
        error: new SDKError("SDK_TRANSPORT", "Failure"),
      }),
    ).toBe(false);
    expect(
      Schema.is(UploadSnapshot)({
        ...fields,
        status: "failed",
        error: new SDKError("SDK_TRANSPORT", "Failure"),
      }),
    ).toBe(true);
    expect(Schema.is(UploadSnapshot)({ ...fields, status: "cancelling" })).toBe(true);
    expect(
      Schema.is(UploadSnapshot)({
        ...fields,
        status: "cancelling",
        error: new SDKError("SDK_TRANSPORT", "Failure"),
      }),
    ).toBe(false);
  });

  test("upload metadata retains the public checkpoint integer boundary", () => {
    const client = createClient({ fetch: fakeAPI().fetch });
    const file = localFile();

    try {
      for (const lastModified of [Number.MAX_SAFE_INTEGER + 1, 1.5, Infinity]) {
        expect(() =>
          client.uploads.start({
            parentId: null,
            file: {
              name: file.name,
              size: file.size,
              type: file.type,
              lastModified,
              slice: (start, end) => file.slice(start, end),
            },
          }),
        ).toThrow(SDKError);
      }
    } finally {
      client.dispose();
    }
  });

  test("owns bounded chunk sequencing, retry, acknowledged progress, and streamed download", async () => {
    const api = fakeAPI();
    api.failParts(1);
    const sdkClient = createClient({ fetch: api.fetch });
    const bytes: number[] = [];

    const upload = sdkClient.uploads.start(
      { parentId: null, file: localFile() },
      { retryDelayMs: 0, onProgress: (snapshot) => bytes.push(snapshot.uploadedBytes) },
    );

    const result = await upload.result;
    expect(result.id).toBe("file_1");
    expect(api.beginCount).toBe(1);
    expect(api.completeCount).toBe(1);
    expect(api.calls.filter((call) => call.startsWith("PUT:"))).toEqual([
      "PUT:1",
      "PUT:1",
      "PUT:2",
      "PUT:3",
    ]);
    expect([...api.stored.values()].flatMap((value) => [...value])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(bytes).toContain(3);
    expect(bytes.at(-1)).toBe(7);
    expect(upload.getSnapshot().status).toBe("complete");
    const download = await sdkClient.downloads.open({ id: result.id });
    expect([...new Uint8Array(await new Response(download.stream).arrayBuffer())]).toEqual([
      1, 2, 3,
    ]);
    sdkClient.dispose();
  });

  test("pause/reload resume requires explicit same-file reselection and skips acknowledged parts", async () => {
    const api = fakeAPI();
    const first = createClient({ fetch: api.fetch });
    let paused = false;
    let task: ReturnType<typeof first.uploads.start>;
    task = first.uploads.start(
      { parentId: null, file: localFile() },
      {
        onProgress(snapshot) {
          if (!paused && snapshot.uploadedBytes === 3) {
            paused = true;
            task.pause();
          }
        },
      },
    );
    await expect(task.result).rejects.toHaveProperty("code", "SDK_CANCELLED");
    expect(task.getSnapshot().status).toBe("paused");

    const checkpoint = decodeUploadCheckpoint(
      JSON.parse(JSON.stringify(task.getSnapshot().checkpoint)),
    );

    first.dispose();
    const second = createClient({ fetch: api.fetch });
    const wrong = new File(["wrong"], "wrong.txt", { lastModified: 42 });
    expect(() => second.uploads.resume({ file: wrong, checkpoint, confirmSameFile: true })).toThrow(
      SDKError,
    );
    const resumed = second.uploads.resume({ file: localFile(), checkpoint, confirmSameFile: true });
    await resumed.result;
    expect(api.beginCount).toBe(1);
    expect(api.calls.filter((call) => call === "PUT:1")).toHaveLength(1);
    expect(api.completeCount).toBe(1);
    second.dispose();
  });

  test("retry is bounded and reconciles saved progress instead of replaying begin", async () => {
    const api = fakeAPI();
    api.failParts(20);
    const sdkClient = createClient({ fetch: api.fetch });

    const task = sdkClient.uploads.start(
      { parentId: null, file: localFile() },
      { maxRetries: 1, retryDelayMs: 0 },
    );

    await expect(task.result).rejects.toHaveProperty("code", "SDK_TRANSPORT");
    expect(api.calls.filter((call) => call === "PUT:1")).toHaveLength(2);
    expect(task.getSnapshot().status).toBe("failed");
    api.failParts(0);
    await task.retry();
    expect(api.beginCount).toBe(1);
    expect(task.getSnapshot().status).toBe("complete");
    sdkClient.dispose();
  });

  test("cancel aborts active transfer and server upload without automatic replay", async () => {
    const api = fakeAPI();
    api.holdNextPart();
    const sdkClient = createClient({ fetch: api.fetch });
    const task = sdkClient.uploads.start({ parentId: null, file: localFile() });
    await until(() => api.calls.includes("PUT:1"));

    const rejected = task.result.then(
      () => null,
      (error) => error,
    );

    await task.cancel();
    expect(await rejected).toHaveProperty("code", "SDK_CANCELLED");
    expect(api.state).toBe("aborted");
    expect(api.completeCount).toBe(0);
    expect(task.getSnapshot().status).toBe("cancelled");
    await expect(task.retry()).rejects.toHaveProperty("code", "SDK_CANCELLED");
    sdkClient.dispose();
  });

  test("validates payload and response, preserves declared errors, and disposes transport", async () => {
    const api = fakeAPI();
    const sdkClient = createClient({ fetch: api.fetch });
    await expect(sdkClient.rpc.files.list({ limit: 0 })).rejects.toHaveProperty(
      "code",
      "SDK_VALIDATION",
    );
    expect(api.calls).toHaveLength(0);
    api.malformed(true);
    await expect(sdkClient.rpc.files.list({})).rejects.toHaveProperty("code", "SDK_PROTOCOL");
    api.malformed(false);
    api.failListing(true);
    await expect(sdkClient.rpc.files.list({})).rejects.toHaveProperty(
      "code",
      "service.unavailable",
    );
    sdkClient.dispose();
    await expect(sdkClient.rpc.auth.status({})).rejects.toHaveProperty("code", "SDK_DISPOSED");
  });
});
