import { expect, test } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type { Client, EditorDocument, OutputOf, RPC } from "@hyori-cloud/client-sdk";
import { createQueryEditorBackend, setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { createQueryClient } from "@hyori-cloud/lib/query";
import { entry } from "#client-sdk-test/fake-api";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture() {
  const client = createClient({
    fetch: async () => {
      throw new Error("Unexpected network in cache-policy unit test");
    },
  });

  const document: EditorDocument = {
    sessionId: "a".repeat(64),
    app: "wordcraft",
    bridge: "upstream-host-parent",
    protocol: null,
    version: "0.14.0",
    assetUrl: "/artcraft/wordcraft/0.14.0/index.html?host=parent",
    name: "Report.docx",
    revision: "0",
    writable: true,
    maxBytes: 16,
    replacementName: "Report.docx",
    outputFormats: [{ extension: ".docx", kind: "document" }],
  };

  const saved: OutputOf<RPC["editors"]["completeSave"]> = {
    status: "saved",
    revision: "1",
    file: entry,
  };

  let fail = false;
  let saves = 0;

  const sdkClient = {
    ...client,
    editors: {
      ...client.editors,
      backend: () => ({
        open: async () => document,
        close: async () => undefined,
        download: async () => new Uint8Array([1, 2, 3]),
        save: async () => {
          saves += 1;

          if (fail) return { status: "failed" as const, message: "Synthetic failed save" };

          return saved;
        },
      }),
    },
  } satisfies Client;

  return {
    sdkClient,
    document,
    get saves() {
      return saves;
    },
    fail(value: boolean) {
      fail = value;
    },
    input: {
      sessionId: document.sessionId,
      expectedRevision: "0",
      saveId: "save1",
      output: { name: document.name, bytes: new Uint8Array([1]), intent: "replace" as const },
    },
  };
}

test("editor cache adapter consumes the generated completion policy, not a feature invalidation registry", async () => {
  const f = fixture();
  const queryClient = createQueryClient();
  setMutationDefaults(queryClient);
  const files = f.sdkClient.query.files.list.getOptions({ parentId: null }).queryKey;
  const photos = f.sdkClient.query.photos.sources.getOptions({}).queryKey;
  const auth = f.sdkClient.query.auth.status.getOptions({}).queryKey;
  const admin = f.sdkClient.query.admin.users.getOptions({}).queryKey;

  const original = f.sdkClient.query.editors.download.getOptions({
    sessionId: f.document.sessionId,
    expectedRevision: "0",
  }).queryKey;

  queryClient.setQueryData(files, { items: [], breadcrumbs: [], nextCursor: null, folder: null });
  queryClient.setQueryData(photos, { allMyFiles: false, folderIds: [] });
  queryClient.setQueryData(auth, { initialized: true, user: null });
  queryClient.setQueryData(admin, { items: [], nextCursor: null });
  queryClient.setQueryData(original, {
    url: "/original",
    name: f.document.name,
    size: 3,
    mimeType: "application/octet-stream",
  });
  const backend = createQueryEditorBackend(f.sdkClient, queryClient, { id: entry.id });
  expect((await backend.save(f.input, { signal: new AbortController().signal })).status).toBe(
    "saved",
  );
  await tick();

  for (const key of [files, photos, auth, admin])
    expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
  expect(queryClient.getQueryState(original)?.isInvalidated).toBe(false);
  expect(f.saves).toBe(1);
  queryClient.clear();
  f.sdkClient.dispose();
});

test("failed editor persistence does not invalidate committed-file views", async () => {
  const f = fixture();
  const queryClient = createQueryClient();
  setMutationDefaults(queryClient);
  const key = f.sdkClient.query.files.list.getOptions({ parentId: null }).queryKey;
  queryClient.setQueryData(key, { items: [], breadcrumbs: [], nextCursor: null, folder: null });
  f.fail(true);
  const backend = createQueryEditorBackend(f.sdkClient, queryClient, { id: entry.id });
  expect((await backend.save(f.input, { signal: new AbortController().signal })).status).toBe(
    "failed",
  );
  expect(queryClient.getQueryState(key)?.isInvalidated).toBe(false);
  queryClient.clear();
  f.sdkClient.dispose();
});

test("cache refresh failure is observed separately and cannot undo a confirmed editor save", async () => {
  const f = fixture();
  const queryClient = createQueryClient();
  const failure = new Error("Synthetic cache failure");
  const observed: unknown[] = [];
  queryClient.invalidateQueries = async () => {
    throw failure;
  };

  const backend = createQueryEditorBackend(f.sdkClient, queryClient, { id: entry.id }, (cause) => {
    observed.push(cause);
  });

  const result = await backend.save(f.input, { signal: new AbortController().signal });
  expect(result.status).toBe("saved");

  if (result.status === "saved") expect(result.file.id).toBe(entry.id);
  await tick();
  expect(observed).toEqual([failure]);
  expect(f.saves).toBe(1);
  queryClient.clear();
  f.sdkClient.dispose();
});
