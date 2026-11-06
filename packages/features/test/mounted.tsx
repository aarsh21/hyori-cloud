import { afterEach, expect, test as bunTest } from "bun:test";
import { createClient } from "@hyori-cloud/client-sdk";
import type { FetchCapability, FileEntry } from "@hyori-cloud/client-sdk";
import { ClientSDKProvider, setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { Schema } from "@hyori-cloud/lib/effect";
import { QueryClient, QueryClientProvider } from "@hyori-cloud/lib/query";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { toast, Toaster } from "@hyori-cloud/ui/components/sonner";
import { TooltipProvider } from "@hyori-cloud/ui/components/tooltip";
import { AppearanceProvider } from "@hyori-cloud/ui/theme";
import { act, cleanup, configure, render, waitFor } from "@testing-library/react";

export { act, fireEvent, screen, waitFor } from "@testing-library/react";

const decodeRequest = Schema.decodeUnknownSync(
  Schema.Struct({ operation: Schema.String, input: Schema.Unknown }),
);

const decodeInput = Schema.decodeUnknownSync(
  Schema.Record({
    key: Schema.String,
    value: Schema.Union(
      Schema.String,
      Schema.Number,
      Schema.Boolean,
      Schema.Null,
      Schema.Array(Schema.String),
      // An editor's explicit destination.
      Schema.Struct({ parentId: Schema.Union(Schema.String, Schema.Null) }),
    ),
  }),
);

export type RequestInput = ReturnType<typeof decodeInput>;

type ApiCode =
  | "auth.required"
  | "access.denied"
  | "input.invalid"
  | "resource.notFound"
  | "resource.conflict"
  | "service.unavailable";

export class ApiFailure {
  constructor(
    readonly code: ApiCode,
    readonly message = "",
  ) {}
}

type Handlers = Record<string, (input: RequestInput) => object | Promise<object>>;

/** Real SDK and Query behavior over a scripted transport. Unscripted operations fail the request. */
/**
 * What every suite would otherwise script for itself: an editor's session ending as it unmounts,
 * which the server answers the same way whatever it finds. Still recorded like any other call.
 */
const ALWAYS_ANSWERED = new Map([["editors.close", () => ({ success: true })]]);

export function createFakeApi(handlers: Handlers) {
  const calls: { readonly operation: string; readonly input: RequestInput }[] = [];

  const fetch: FetchCapability = async (_url, init) => {
    // A file's bytes, not an operation: the SDK asked for a URL an operation gave it.
    if (init?.body === undefined || init.body === null) return new Response("file bytes");

    // A part's bytes on their way to a storage URL, which isn't an operation either.
    if (init.method === "PUT") return new Response(null, { status: 200 });

    const request = decodeRequest(await new Response(init.body).json());
    const input = decodeInput(request.input);

    calls.push({ operation: request.operation, input });
    const handler = handlers[request.operation] ?? ALWAYS_ANSWERED.get(request.operation);

    if (handler === undefined) throw new Error(`Unscripted operation: ${request.operation}`);

    try {
      return Response.json({ ok: true, value: await handler(input) });
    } catch (failure) {
      if (!(failure instanceof ApiFailure)) throw failure;

      return Response.json(
        { ok: false, error: { code: failure.code, message: failure.message } },
        { status: 400 },
      );
    }
  };

  return {
    fetch,
    calls,
    handlers,
    callsTo: (operation: string) => calls.filter((call) => call.operation === operation),
  };
}

export type FakeApi = ReturnType<typeof createFakeApi>;

const queryClients: QueryClient[] = [];

/** Mounts below the same provider order and query defaults the application composes. */
export function mount(ui: ReactNode, api: FakeApi) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { staleTime: 15_000, retry: false, refetchOnWindowFocus: false },
      mutations: { retry: false },
    },
  });

  setMutationDefaults(queryClient);
  queryClients.push(queryClient);
  const sdkClient = createClient({ fetch: api.fetch });

  const tree = (children: ReactNode) => (
    <AppearanceProvider>
      <QueryClientProvider client={queryClient}>
        <ClientSDKProvider sdkClient={sdkClient}>
          <TooltipProvider>{children}</TooltipProvider>
          <Toaster />
        </ClientSDKProvider>
      </QueryClientProvider>
    </AppearanceProvider>
  );

  const view = render(tree(ui));

  return {
    container: view.container,
    refetchActive: () => act(() => queryClient.refetchQueries({ type: "active" })),
    rerender: (next: ReactNode) => view.rerender(tree(next)),
  };
}

const ANIMATION_FRAMES_MS = 40;
const TEST_TIMEOUT_MS = 30_000;

// The default 1s is about the time a cold module load takes on a busy CI machine.
configure({ asyncUtilTimeout: 5_000 });

/**
 * Every test settles before it counts as finished. Otherwise a late response or a Base UI animation
 * frame can land after the last assertion but before cleanup, outside anything `act` can see. A
 * request that never finishes fails its test here instead of leaking into the next one.
 */
export function test(name: string, body: () => void | Promise<void>) {
  bunTest(
    name,
    async () => {
      await body();
      await waitFor(() => {
        for (const client of queryClients) {
          expect(client.isFetching() + client.isMutating()).toBe(0);
        }
      });
      await act(() => new Promise((settled) => setTimeout(settled, ANIMATION_FRAMES_MS)));
    },
    TEST_TIMEOUT_MS,
  );
}

export function deferred<Value>() {
  let resolve: (value: Value) => void = () => undefined;

  const promise = new Promise<Value>((onResolve) => {
    resolve = onResolve;
  });

  return { promise, resolve };
}

// This module is preloaded, which is what makes the hook apply to every suite in the process.
afterEach(() => {
  cleanup();
  toast.dismiss();
  localStorage.clear();

  for (const client of queryClients.splice(0)) client.clear();
});

export const OWNER_ACCESS: FileEntry["access"] = {
  role: null,
  isOwner: true,
  canDownload: true,
  canUpload: true,
  canEdit: true,
  canDelete: true,
  canShare: true,
};

export const VIEWER_ACCESS: FileEntry["access"] = {
  role: "viewer",
  isOwner: false,
  canDownload: true,
  canUpload: false,
  canEdit: false,
  canDelete: false,
  canShare: false,
};

export function fileEntry(overrides: Partial<FileEntry> & Pick<FileEntry, "id" | "name">) {
  const entry: FileEntry = {
    kind: "file",
    parentId: null,
    ownerId: "user_1",
    size: 7,
    mimeType: "text/plain",
    createdAt: "2026-11-04T00:00:00Z",
    updatedAt: "2026-11-04T00:00:00Z",
    trashedAt: null,
    access: OWNER_ACCESS,
    ...overrides,
  };

  return entry;
}

export function folderEntry(overrides: Partial<FileEntry> & Pick<FileEntry, "id" | "name">) {
  return fileEntry({ kind: "folder", size: 0, mimeType: "inode/directory", ...overrides });
}

export function fileList(
  items: readonly FileEntry[],
  folder: FileEntry | null = null,
  breadcrumbs: readonly { readonly id: string; readonly name: string }[] = [],
) {
  return { items, folder, breadcrumbs, nextCursor: null };
}

export const SIGNED_IN_USER = {
  id: "user_1",
  email: "ada@example.com",
  name: "Ada",
  role: "user",
  quotaBytes: 1024,
  usedBytes: 64,
} as const;
