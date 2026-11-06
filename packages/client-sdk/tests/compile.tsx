import {
  createClient,
  createEditorSession,
  createUploadQueue,
  getUploadFailure,
} from "@hyori-cloud/client-sdk";
import { createBrowserEditorMessages } from "@hyori-cloud/client-sdk/browser";
import { decodeNativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import type { NativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";
import type {
  CheckpointStore,
  EditorSession,
  ReplaceUpload,
  UploadFile,
  UploadIntent,
} from "@hyori-cloud/client-sdk";
import type { InputOf, OutputOf, FileEntry, UploadSnapshot } from "@hyori-cloud/client-sdk";
import {
  ClientSDKProvider,
  createQuery,
  createQueryEditorBackend,
  setMutationDefaults,
  useClientSDK,
  useEditorSession,
} from "@hyori-cloud/client-sdk/react";
import type { ResourceOf, SuspenseResourceOf } from "@hyori-cloud/client-sdk/react";
import { QueryClient, useMutation, useQuery, useSuspenseQuery } from "@hyori-cloud/lib/query";

const sdkClient = createClient({
  baseUrl: "https://example.invalid/api/rpc",
  cacheScope: "account-1",
});

const queryClient = new QueryClient();

setMutationDefaults(queryClient);

const query = createQuery(sdkClient);

queryClient.prefetchQuery(query.files.list.getOptions({ parentId: null }));

queryClient.setQueryData(query.files.list.getKey({}), {
  items: [],
  folder: null,
  breadcrumbs: [],
  nextCursor: null,
});

// @ts-expect-error Cache writes retain the declared output type.
queryClient.setQueryData(query.files.list.getKey({}), { incorrect: true });

// @ts-expect-error Query/mutation namespaces are filtered by authoritative kind.
void query.files.createFolder;

// @ts-expect-error Mutations cannot be projected as query resources.
export type InvalidResource = ResourceOf<typeof sdkClient.mutation.files.createFolder>;

// @ts-expect-error Arbitrary values are not valid operation type helpers.
export type InvalidInput = InputOf<number>;

// @ts-expect-error Input remains runtime-schema derived.
query.files.list.getOptions({ limit: "one" });

export type ListingInput = InputOf<typeof query.files.list>;

export type SameInput = InputOf<typeof query.files.list.getOptions>;

export type Listing = OutputOf<typeof query.files.list>;

export type SameListing = OutputOf<typeof query.files.list.getOptions>;

export type Created = OutputOf<typeof sdkClient.rpc.files.createFolder>;

export type AuthInput = InputOf<typeof query.auth.status.getOptions>;

export const emptyInput: AuthInput = {};

// Function callability constraints must preserve payloads even when a function returns null or void.
export const functionInput: InputOf<(input: { id: string }) => null> = { id: "example" };

export const functionOutput: OutputOf<(input: { id: string }) => Promise<null>> = null;

// @ts-expect-error Ordinary function input extraction must not become an unconstrained payload.
export const invalidFunctionInput: InputOf<(input: { id: string }) => void> = { id: 42 };

// @ts-expect-error Output inference keeps the actual return type, not the callability constraint.
export const invalidFunctionOutput: OutputOf<(input: { id: string }) => Promise<null>> = 42;

// @ts-expect-error A failed upload must carry an actual normalized error.
export const invalidFailure: Extract<UploadSnapshot, { status: "failed" }>["error"] = null;

// @ts-expect-error A completed upload requires the committed file.
export const invalidCompletion: Extract<UploadSnapshot, { status: "complete" }>["file"] = null;

export function useListing(input: ListingInput): ResourceOf<typeof query.files.list> {
  const client = useClientSDK();

  return useQuery(client.query.files.list.getOptions(input));
}

export function useSuspenseListing(
  input: ListingInput,
): SuspenseResourceOf<typeof query.files.list.getOptions> {
  return useSuspenseQuery(useClientSDK().query.files.list.getOptions(input));
}

export function useEditorAvailability() {
  const availability = useQuery(useClientSDK().query.editors.available.getOptions({}));
  const extension: string | undefined = availability.data?.apps[0]?.inputExtensions[0];
  // @ts-expect-error Generated availability versions are strings, not any.
  const invalid: number = availability.data?.apps[0]?.version;

  return { availability, extension, invalid };
}

export function useCreateFolder() {
  return useMutation(useClientSDK().mutation.files.createFolder.mutationOptions());
}

sdkClient.mutation.files.createFolder.setDefaults(queryClient, {
  onMutate(input) {
    return { oldName: input.name };
  },
  onError(_error, _input, context) {
    const original: string | undefined = context?.oldName;
    void original;
  },
  onSuccess(file, input) {
    const typedFile: FileEntry = file;
    const typedName: string = input.name;
    void typedFile;
    void typedName;
  },
});

sdkClient.mutation.files.createFolder.setDefaults(queryClient, {
  // @ts-expect-error mutation callbacks infer the actual operation result.
  onSuccess(file: number) {
    void file;
  },
});

export function replaceFromVanilla(file: UploadFile, store: CheckpointStore) {
  const input: ReplaceUpload = {
    file,
    parentId: null,
    target: { id: "file_1", name: "report.docx" },
  };

  const queue = createUploadQueue(sdkClient, store);
  queue.replace(input);
  const task = sdkClient.uploads.replace(input);
  const intent: UploadIntent = task.intent;

  if (intent.kind === "replacement") {
    const targetId: string = intent.targetId;
    void targetId;
  }

  const snapshot = task.getSnapshot();

  if (snapshot.status === "failed") getUploadFailure(intent, snapshot.error);
  // @ts-expect-error An explicit replacement requires a target ID and target name.
  sdkClient.uploads.replace({ file, parentId: null });
  // @ts-expect-error The queue uses the same replacement input contract.
  queue.replace({ file, parentId: null, target: { name: "report.docx" } });

  return { queue, task };
}

export function bindBrowserEditor(host: Window, editorWindow: Window, id: string) {
  const backend = createQueryEditorBackend(sdkClient, queryClient, {
    id,
    chooseDestination: async () => ({ parentId: null }),
  });

  const messages = createBrowserEditorMessages({
    host,
    editorWindow,
    origin: host.location.origin,
  });

  return createEditorSession({
    backend,
    messages,
    maxBytes: 64 * 1024 * 1024,
    autosave: { idleMs: 750, maxWaitMs: 5000 },
    theme: "system",
  });
}

export function useBoundEditor(session: EditorSession) {
  const snapshot = useEditorSession(session);
  const lastSavedAt: number | null = snapshot.lastSavedAt;

  return { snapshot, lastSavedAt };
}

export function flushBoundEditor(session: EditorSession) {
  const accepted: boolean = session.requestSave();
  const copyAccepted: boolean = session.requestSave({ saveAs: true, name: "Copy.docx" });
  const themed: boolean = session.setTheme("dark");

  // @ts-expect-error Explicit copies require the user's output name.
  session.requestSave({ saveAs: true });
  // @ts-expect-error Theme values are the owned native protocol, not arbitrary CSS.
  session.setTheme("sepia");

  return { accepted, copyAccepted, themed };
}

export function consumeNativeCommand(command: NativeHostCommand) {
  return decodeNativeHostCommand(command);
}

export async function saveEditorOutput(id: string, bytes: Uint8Array<ArrayBuffer>) {
  const backend = createQueryEditorBackend(sdkClient, queryClient, { id });
  const context = { signal: new AbortController().signal };
  const document = await backend.open(context);

  const input = {
    sessionId: document.sessionId,
    expectedRevision: document.revision,
    output: { name: document.name, bytes, intent: "replace" as const },
  };

  // @ts-expect-error Persistence always requires a stable save identity.
  void backend.save(input, context);
  const saved = await backend.save({ ...input, saveId: "compile-save" }, context);

  if (saved.status === "saved") {
    const file: FileEntry = saved.file;
    const revision: string = saved.revision;

    return { file, revision };
  }

  return saved;
}

export function Fixture() {
  return (
    <ClientSDKProvider sdkClient={sdkClient}>
      <FixtureConsumer />
    </ClientSDKProvider>
  );
}

function FixtureConsumer() {
  const result = useListing({});

  if (result.status === "success") {
    const entries: readonly FileEntry[] = result.data.items;
    void entries;
  }

  return null;
}
