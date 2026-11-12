import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type {
  EditorBackendOptions,
  EditorDocument,
  FetchCapability,
  FileEntry,
  InputOf,
  OutputOf,
  RPC,
  ResumeUpload,
  UploadOptions,
  UploadTask,
} from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
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

  let readDenied = false;

  let preparationError: {
    code:
      | "resource.conflict"
      | "access.denied"
      | "resource.notFound"
      | "auth.required"
      | "service.unavailable";
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

      if (readDenied) throw { code: "access.denied", message: "Revoked" };

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
    denyRead() {
      readDenied = true;
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

  // No destination is a distinct, certain no-write outcome rather than an ambiguous failure.
  expect((await absent.save(copy, { signal: active() })).status).toBe("cancelled");
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
  // A replacement refused while the session still exists is an Edit to Viewer downgrade.
  ["access.denied", "read-only"],
  ["resource.notFound", "access-ended"],
  ["auth.required", "access-ended"],
  ["service.unavailable", "failed"],
] as const) {
  test(`binding maps ${code} from its code alone, never from human messages`, async () => {
    const f = fixture();
    const backend = f.backend();
    await backend.open({ signal: active() });
    f.failPreparation({ code, message: "A deliberately misleading filename or permission hint" });
    expect((await backend.save(f.input, { signal: active() })).status).toBe(expected);
    expect(f.resumes).toHaveLength(0);
    f.collection.dispose();
  });
}

test("a denied replacement that can no longer read the source has lost access, not Edit", async () => {
  const f = fixture();
  const backend = f.backend();
  await backend.open({ signal: active() });
  f.failPreparation({ code: "access.denied", message: "Revoked link" });
  f.denyRead();
  expect((await backend.save(f.input, { signal: active() })).status).toBe("access-ended");
  f.collection.dispose();
});

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

/**
 * Through the public client, over the wire: a tab on a verified legacy version while the
 * deployment has selected a newer current one. The server keeps saving such sessions.
 */
function legacyTab() {
  const document: EditorDocument = {
    sessionId: "b".repeat(64),
    app: "wordcraft",
    version: "0.14.0",
    bridge: "upstream-host-parent",
    protocol: null,
    assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
    name: "Report.docx",
    revision: "0",
    writable: true,
    maxBytes: 16,
    replacementName: "Report.docx",
    outputFormats: [{ extension: ".docx", kind: "document", maxBytes: 16 }],
  };

  const decodeRequest = Schema.decodeUnknownSync(
    Schema.Struct({
      operation: Schema.String,
      input: Schema.Struct({ saveId: Schema.optional(Schema.String) }),
    }),
  );

  const replies: { code: string; status: number }[] = [];
  const operations: string[] = [];
  const saveIds: unknown[] = [];

  const fetch: FetchCapability = async (_url, init) => {
    const { operation, input } = decodeRequest(await new Response(init?.body).json());

    operations.push(operation);

    if (operation === "editors.open") return Response.json({ ok: true, value: document });

    if (operation === "editors.close") return Response.json({ ok: true, value: { success: true } });

    // The deployment's selected current version is newer than the one this tab runs.
    if (operation === "editors.available")
      return Response.json({
        ok: true,
        value: { apps: [{ app: "wordcraft", inputExtensions: [".docx"], version: "0.15.0" }] },
      });

    if (operation === "editors.download")
      return Response.json({
        ok: true,
        value: { url: "/editor-original", name: document.name, size: 3, mimeType: "text/plain" },
      });

    if (operation === "editors.prepareSave") {
      saveIds.push(input.saveId);

      const reply = replies.shift() ?? { code: "service.unavailable", status: 503 };

      return Response.json(
        { ok: false, error: { code: reply.code, message: "Synthetic refusal" } },
        { status: reply.status },
      );
    }

    throw new Error(`Unexpected ${operation}`);
  };

  const client = createClient({ fetch });
  const backend = client.editors.backend({ id: entry.id });

  const input = {
    sessionId: document.sessionId,
    expectedRevision: document.revision,
    saveId: "legacy-save-1",
    output: { name: document.name, bytes: new Uint8Array([1, 2, 3]), intent: "replace" as const },
  };

  return {
    backend,
    input,
    operations,
    saveIds,
    nextPreparation(code: string, status: number) {
      replies.push({ code, status });
    },
    dispose: () => client.dispose(),
  };
}

test("a legacy tab's transiently unavailable save stays retryable when a newer editor is current", async () => {
  const tab = legacyTab();
  await tab.backend.open({ signal: active() });

  tab.nextPreparation("service.unavailable", 503);
  expect(await tab.backend.save(tab.input, { signal: active() })).toMatchObject({
    status: "failed",
  });

  // Retrying is still allowed, and reaches the server with the same save.
  tab.nextPreparation("service.unavailable", 503);
  expect((await tab.backend.save(tab.input, { signal: active() })).status).toBe("failed");
  expect(tab.saveIds).toEqual(["legacy-save-1", "legacy-save-1"]);
  tab.dispose();
});

for (const [code, status, reason] of [
  ["auth.required", 401, "access-revoked"],
  ["resource.notFound", 404, "session-ended"],
] as const) {
  test(`a legacy tab's session still ends when the server says so for it (${code})`, async () => {
    const tab = legacyTab();
    await tab.backend.open({ signal: active() });

    tab.nextPreparation("service.unavailable", 503);
    expect((await tab.backend.save(tab.input, { signal: active() })).status).toBe("failed");
    tab.nextPreparation(code, status);
    expect(await tab.backend.save(tab.input, { signal: active() })).toMatchObject({
      status: "access-ended",
      reason,
    });
    tab.dispose();
  });
}
