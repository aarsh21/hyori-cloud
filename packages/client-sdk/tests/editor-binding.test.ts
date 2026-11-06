import { expect, test } from "bun:test";
import type {
  EditorBackendOptions,
  EditorDocument,
  FileEntry,
  InputOf,
  OutputOf,
  RPC,
  ResumeUpload,
  UploadOptions,
  UploadTask,
} from "@hyori-cloud/client-sdk";
import { createEditors } from "#client-sdk/features/editors/create-editors";
import { entry } from "#client-sdk-test/fake-api";

const active = () => new AbortController().signal;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

// Narrow fake capabilities test local behavior, not PostgreSQL, format or storage correctness.
function fixture(overrides: Partial<EditorDocument> = {}) {
  const document: EditorDocument = {
    sessionId: "a".repeat(64),
    app: "wordcraft",
    version: "0.14.0",
    bridge: overrides.app === "deckcraft" ? "hyori-correlated-host-v1" : "upstream-host-parent",
    protocol: overrides.app === "deckcraft" ? 1 : null,
    assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
    name: "Report.docx",
    revision: "0",
    writable: true,
    maxBytes: 16,
    replacementName: "Report.docx",
    outputFormats: [
      { extension: ".docx", kind: "document", maxBytes: 16 },
      { extension: ".pdf", kind: "export", maxBytes: 2 },
    ],
    ...overrides,
  };

  const file: FileEntry = { ...entry, name: document.name, size: 3 };
  const saved: OutputOf<RPC["editors"]["completeSave"]> = { status: "saved", revision: "1", file };
  const calls: string[] = [];
  const preparations: InputOf<RPC["editors"]["prepareSave"]>[] = [];
  const resumes: ResumeUpload[] = [];
  const resumed = Promise.withResolvers<void>();
  let disposed = 0;
  let failedReplies = 0;

  let preparationError: {
    code: "resource.conflict" | "access.denied" | "service.unavailable";
    message: string;
  } | null = null;

  let transfer: Promise<FileEntry> | null = null;
  let response = () => new Response(new Uint8Array([1, 2, 3]));

  const rpc: RPC["editors"] = {
    available: async () => ({ apps: [] }),
    close: async () => {
      calls.push("close");

      return { success: true };
    },
    open: async () => {
      calls.push("open");

      return document;
    },
    download: async () => {
      calls.push("download");

      return {
        url: "/editor-original",
        name: document.name,
        size: 3,
        mimeType: "application/octet-stream",
      };
    },
    prepareSave: async (input) => {
      calls.push("prepare");
      preparations.push(input);

      if (preparationError) throw preparationError;

      return {
        uploadId: "prepared_1",
        chunkSize: 3,
        totalParts: 1,
        parts: [],
        state: "uploading",
        fileId: null,
      };
    },
    completeSave: async () => {
      calls.push("complete");

      if (failedReplies > 0) {
        failedReplies -= 1;
        throw new Error("Synthetic lost committed reply");
      }

      return saved;
    },
  };

  const collection = createEditors(
    rpc,
    {
      resume(input: ResumeUpload, _options?: UploadOptions): UploadTask {
        resumes.push(input);
        resumed.resolve();

        if (input.checkpoint.version !== 2)
          throw new Error("Binding must preserve explicit intent");

        return {
          intent: input.checkpoint.intent,
          result: transfer ?? Promise.resolve(file),
          getSnapshot: () => ({
            status: "complete",
            uploadedBytes: 3,
            totalBytes: 3,
            checkpoint: input.checkpoint,
            error: null,
            file,
          }),
          subscribe: () => () => undefined,
          pause: () => undefined,
          cancel: async () => undefined,
          retry: async () => file,
          dispose: () => {
            disposed += 1;
          },
        };
      },
    },
    async () => response(),
  );

  const input = {
    sessionId: document.sessionId,
    expectedRevision: document.revision,
    saveId: "stable-save-1",
    output: {
      name: document.name,
      bytes: new TextEncoder().encode("abc"),
      intent: "replace" as const,
    },
  };

  return {
    document,
    collection,
    input,
    calls,
    preparations,
    resumes,
    resumed: resumed.promise,
    get disposed() {
      return disposed;
    },
    failReplies(count: number) {
      failedReplies = count;
    },
    failPreparation(error: typeof preparationError) {
      preparationError = error;
    },
    holdTransfer(promise: Promise<FileEntry>) {
      transfer = promise;
    },
    downloadWith(next: typeof response) {
      response = next;
    },
    backend(options: Omit<EditorBackendOptions, "id"> = {}) {
      return collection.backend({ id: entry.id, ...options });
    },
  };
}

test("binding reuses prepared multipart identity and passes the actual committed file through", async () => {
  const f = fixture();
  const backend = f.backend();
  const document = await backend.open({ signal: active() });
  expect(await backend.download(document, { signal: active() })).toEqual(new Uint8Array([1, 2, 3]));
  const saved = await backend.save(f.input, { signal: active() });
  expect(saved.status).toBe("saved");

  if (saved.status === "saved") expect(saved.file.id).toBe(entry.id);
  expect(f.preparations[0]?.sha256).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  expect(f.resumes[0]?.checkpoint.uploadId).toBe("prepared_1");
  expect(f.resumes[0]?.checkpoint.version).toBe(2);
  expect(f.resumes[0]?.file.name).toBe("Report.docx");
  expect(f.disposed).toBe(1);
  expect(f.calls).toEqual(["open", "download", "prepare", "complete"]);
  f.collection.dispose();
});

test("ambiguous completion retry preserves save ID, digest, original revision and upload ID", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  f.failReplies(1);
  expect((await backend.save(f.input, { signal: active() })).status).toBe("failed");
  expect((await backend.save(f.input, { signal: active() })).status).toBe("saved");
  expect(f.preparations).toHaveLength(2);
  expect(f.preparations[0]).toEqual(f.preparations[1]);
  expect(f.resumes.map((attempt) => attempt.checkpoint.uploadId)).toEqual([
    "prepared_1",
    "prepared_1",
  ]);
  expect(f.disposed).toBe(2);
  f.collection.dispose();
});

test("automatic mode is preserved on exact retry; legacy omission remains absent", async () => {
  for (const saveMode of [undefined, "manual", "automatic"] as const) {
    const f = fixture();
    const backend = f.backend();
    await backend.open({ signal: active() });
    f.failReplies(1);
    const input = saveMode === undefined ? f.input : { ...f.input, saveMode };

    expect((await backend.save(input, { signal: active() })).status).toBe("failed");
    expect((await backend.save(input, { signal: active() })).status).toBe("saved");
    expect(f.preparations).toHaveLength(2);
    expect(f.preparations[0]).toEqual(f.preparations[1]);
    expect(f.preparations[0]?.saveMode).toBe(saveMode);
    expect(Object.hasOwn(f.preparations[0]!, "saveMode")).toBe(saveMode !== undefined);
    f.collection.dispose();
  }
});

test("automatic copies never invoke a local destination chooser or prepare", async () => {
  const f = fixture();
  let choices = 0;

  const backend = f.backend({
    chooseDestination: async () => {
      choices += 1;

      return { parentId: null };
    },
  });

  await backend.open({ signal: active() });

  const result = await backend.save(
    {
      ...f.input,
      saveMode: "automatic",
      output: { ...f.input.output, name: "Copy.docx", intent: "save-as" },
    },
    { signal: active() },
  );

  expect(result.status).toBe("failed");
  expect(choices).toBe(0);
  expect(f.preparations).toHaveLength(0);
  f.collection.dispose();
});

test("copy/export needs explicit destination; user choice is retained across retries", async () => {
  const f = fixture();
  const absent = f.backend();
  await absent.open({ signal: active() });

  const copy = {
    ...f.input,
    output: { ...f.input.output, name: "Copy.docx", intent: "save-as" as const },
  };

  expect((await absent.save(copy, { signal: active() })).status).toBe("failed");
  expect(f.preparations).toHaveLength(0);
  let choices = 0;

  const backend = f.backend({
    chooseDestination: async () => {
      choices += 1;

      return { parentId: "chosen-folder" };
    },
  });

  await backend.open({ signal: active() });
  f.failReplies(1);
  expect((await backend.save(copy, { signal: active() })).status).toBe("failed");
  expect((await backend.save(copy, { signal: active() })).status).toBe("saved");
  expect(choices).toBe(1);
  expect(f.preparations[0]?.destination).toEqual({ parentId: "chosen-folder" });
  expect(f.preparations[1]?.destination).toEqual(f.preparations[0]?.destination);
  f.collection.dispose();
});

test("per-format and attachment ceilings reject output before preparing a transfer", async () => {
  const f = fixture();
  const backend = f.backend({ destination: { parentId: null } });
  await backend.open({ signal: active() });

  const oversizedExport = {
    ...f.input,
    output: { ...f.input.output, name: "Report.pdf", intent: "export" as const },
  };

  expect((await backend.save(oversizedExport, { signal: active() })).status).toBe("failed");
  expect(
    (
      await backend.save(
        { ...f.input, output: { ...f.input.output, bytes: new Uint8Array(17) } },
        { signal: active() },
      )
    ).status,
  ).toBe("failed");
  expect(f.preparations).toHaveLength(0);
  f.collection.dispose();
});

for (const [code, expected] of [
  ["resource.conflict", "conflict"],
  ["access.denied", "access-ended"],
  ["service.unavailable", "failed"],
] as const) {
  test(`binding maps ${code} without parsing human messages or inventing read-only causes`, async () => {
    const f = fixture();
    const backend = f.backend();
    await backend.open({ signal: active() });
    f.failPreparation({ code, message: "A deliberately misleading filename or permission hint" });
    expect((await backend.save(f.input, { signal: active() })).status).toBe(expected);
    expect(f.resumes).toHaveLength(0);
    f.collection.dispose();
  });
}

test("local admission holds one output and client disposal cancels byte readers", async () => {
  const f = fixture();
  const backend = f.backend();
  const document = await backend.open({ signal: active() });
  const pending = Promise.withResolvers<FileEntry>();
  f.holdTransfer(pending.promise);
  const first = backend.save(f.input, { signal: active() });
  await f.resumed;
  expect(f.resumes).toHaveLength(1);
  expect((await backend.save({ ...f.input, saveId: "second" }, { signal: active() })).status).toBe(
    "failed",
  );
  pending.resolve(entry);
  await first;
  let cancelled = false;
  f.downloadWith(
    () =>
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
  );
  const download = backend.download(document, { signal: active() });
  await tick();
  f.collection.dispose();
  await expect(download).rejects.toMatchObject({ code: "SDK_CANCELLED" });
  expect(cancelled).toBe(true);
});

test("bound close retires a clean session once and refuses new attachment work", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  await backend.close();
  await backend.close();
  expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
  await expect(backend.open({ signal: active() })).rejects.toMatchObject({ code: "SDK_DISPOSED" });
  f.collection.dispose();
});

test("close waits for an already-opening descriptor rather than leaking the known handle", async () => {
  const f = fixture();
  const backend = f.backend();
  const opening = backend.open({ signal: active() });
  const closing = backend.close();
  await opening;
  await closing;
  expect(f.calls).toEqual(["open", "close"]);
  f.collection.dispose();
});

test("ambiguous publication is never auto-closed or stripped of its stable replay state", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  f.failReplies(1);
  expect((await backend.save(f.input, { signal: active() })).status).toBe("failed");
  await backend.close();
  f.collection.dispose();
  await tick();
  expect(f.calls.filter((call) => call === "close")).toHaveLength(0);
});

test("close fences local work but releases a late save only after its completion is known", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  const transfer = Promise.withResolvers<FileEntry>();
  f.holdTransfer(transfer.promise);
  const save = backend.save(f.input, { signal: active() });
  await f.resumed;
  await backend.close();
  expect(f.calls.filter((call) => call === "close")).toHaveLength(0);
  transfer.resolve(entry);
  expect((await save).status).toBe("saved");
  await tick();
  expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
  f.collection.dispose();
});

test("a rejected preparation can release its scope without pretending that anything was saved", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  f.failPreparation({ code: "resource.conflict", message: "Changed baseline" });
  expect((await backend.save(f.input, { signal: active() })).status).toBe("conflict");
  await backend.close();
  expect(f.resumes).toHaveLength(0);
  expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
  f.collection.dispose();
});

test("namespace disposal starts clean-handle release before aborting the client lifetime", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  f.collection.dispose();
  await tick();
  expect(f.calls.filter((call) => call === "close")).toHaveLength(1);
});
