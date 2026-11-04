import type { FetchCapability, FileEntry, FileList, User } from "@hyori-cloud/client-sdk";
import { BeginUpload, CreateFolder, UploadPartInput } from "@hyori-cloud/api/rpc";
import { Schema } from "@hyori-cloud/lib/effect";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
);

export const entry: FileEntry = {
  id: "file_1",
  name: "hello.txt",
  kind: "file",
  parentId: null,
  ownerId: "user_1",
  size: 7,
  mimeType: "text/plain",
  createdAt: "2026-11-04T00:00:00Z",
  updatedAt: "2026-11-04T00:00:00Z",
  trashedAt: null,
  access: {
    role: null,
    isOwner: true,
    canDownload: true,
    canUpload: true,
    canEdit: true,
    canDelete: true,
    canShare: true,
  },
};

export const user: User = {
  id: "user_1",
  email: "person@example.test",
  name: "Person",
  role: "admin",
  quotaBytes: 1000,
  usedBytes: 7,
};

export function fakeAPI() {
  const calls: string[] = [];
  const stored = new Map<number, Uint8Array>();
  let state: "uploading" | "complete" | "aborted" = "uploading";
  let partFailures = 0;
  let failListing = false;
  let failAuthStatus = false;
  let failAbort = false;
  let abortGate: Promise<void> | null = null;
  let confirmationGate: Promise<void> | null = null;
  let authUser: User | null = null;
  let content: FileEntry[] = [];
  let beginCount = 0;
  let completeCount = 0;
  let pendingPart: (() => void) | undefined;
  let holdPart = false;
  let malformedResult = false;
  let lastSize = entry.size;
  const ok = <Value>(value: Value) => Response.json({ ok: true, value });

  const fetch: FetchCapability = async (url, init) => {
    const target = String(url);

    if (target.includes("/binary/")) {
      const number = Number(target.split("/").at(-1));
      calls.push(`PUT:${number}`);

      if (holdPart) {
        holdPart = false;
        await new Promise<void>((resolve, reject) => {
          pendingPart = resolve;
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        });
      }

      if (partFailures-- > 0) throw new TypeError("Simulated connection interruption");
      const body = init?.body;

      if (!(body instanceof Blob)) throw new Error("The SDK must send bounded Blob parts.");
      stored.set(number, new Uint8Array(await body.arrayBuffer()));

      return new Response(null, { status: 204 });
    }

    if (target.includes("/download")) return new Response(new Uint8Array([1, 2, 3]));

    const { operation, input } = decodeRequest(await new Response(init?.body).json());

    calls.push(operation);

    if (operation === "auth.status") {
      if (failAuthStatus)
        return Response.json(
          { ok: false, error: { code: "service.unavailable", message: "Auth offline for test" } },
          { status: 503 },
        );

      return ok({ initialized: true, user: authUser });
    }

    if (operation === "auth.logout") {
      authUser = null;

      return ok({ success: true });
    }

    if (["auth.login", "auth.setup", "auth.acceptInvite"].includes(operation)) {
      authUser ??= user;

      return ok(authUser);
    }

    if (operation === "files.list") {
      if (failListing)
        return Response.json(
          { ok: false, error: { code: "service.unavailable", message: "Offline for test" } },
          { status: 503 },
        );
      const listing: FileList = { items: content, folder: null, breadcrumbs: [], nextCursor: null };

      return ok(malformedResult ? { items: "bad" } : listing);
    }

    if (operation === "files.createFolder") {
      const folder: FileEntry = {
        ...entry,
        id: `folder_${content.length}`,
        kind: "folder",
        name: Schema.decodeUnknownSync(CreateFolder)(input).name,
        size: 0,
      };

      content = [...content, folder];

      return ok(folder);
    }

    if (operation === "files.download")
      return ok({ url: "/download", name: entry.name, size: 3, mimeType: entry.mimeType });

    if (operation === "uploads.begin") {
      beginCount++;
      lastSize = Schema.decodeUnknownSync(BeginUpload)(input).size;
    }

    if (operation === "uploads.begin" || operation === "uploads.status") {
      if (operation === "uploads.status" && state === "aborted") await confirmationGate;

      return ok({
        uploadId: "upload_1",
        chunkSize: 3,
        totalParts: Math.max(1, Math.ceil(lastSize / 3)),
        parts: [...stored].map(([partNumber, bytes]) => ({ partNumber, size: bytes.byteLength })),
        state,
        fileId: state === "complete" ? entry.id : null,
      });
    }

    if (operation === "uploads.part")
      return ok({
        url: `/binary/${Schema.decodeUnknownSync(UploadPartInput)(input).partNumber}`,
        method: "PUT",
        headers: {},
      });

    if (operation === "uploads.complete") {
      completeCount++;
      state = "complete";

      return ok({ ...entry, size: lastSize });
    }

    if (operation === "uploads.abort") {
      await abortGate;

      if (state === "complete")
        return Response.json(
          { ok: false, error: { code: "resource.conflict", message: "Upload already committed" } },
          { status: 409 },
        );

      if (failAbort)
        return Response.json(
          { ok: false, error: { code: "service.unavailable", message: "Abort unavailable" } },
          { status: 503 },
        );
      state = "aborted";

      return ok({ success: true });
    }

    throw new Error(`Unexpected fake operation ${operation}`);
  };

  return {
    fetch,
    calls,
    stored,
    failParts: (count: number) => {
      partFailures = count;
    },
    failListing: (fail: boolean) => {
      failListing = fail;
    },
    holdAbortUntil: (gate: Promise<void>) => {
      abortGate = gate;
    },
    holdAbortConfirmationUntil: (gate: Promise<void>) => {
      confirmationGate = gate;
    },
    failAbort: (fail: boolean) => {
      failAbort = fail;
    },
    completeElsewhere: () => {
      state = "complete";
    },
    setAuthUser: (value: User | null) => {
      authUser = value;
    },
    failAuthStatus: (fail: boolean) => {
      failAuthStatus = fail;
    },
    malformed: (value: boolean) => {
      malformedResult = value;
    },
    holdNextPart: () => {
      holdPart = true;
    },
    releasePart: () => pendingPart?.(),
    get beginCount() {
      return beginCount;
    },
    get completeCount() {
      return completeCount;
    },
    get state() {
      return state;
    },
  };
}
