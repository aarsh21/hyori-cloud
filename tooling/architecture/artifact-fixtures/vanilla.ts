import { createClient, SDKError, type InputOf, type OutputOf } from "@hyori-cloud/client-sdk";
import { createBrowserEditorMessages } from "@hyori-cloud/client-sdk/browser";
import {
  decodeNativeHostCommand,
  decodeNativeHostEvent,
} from "@hyori-cloud/client-sdk/editor-runtime";
import type { NativeHostCommand } from "@hyori-cloud/client-sdk/editor-runtime";

const nativeCommand: NativeHostCommand = {
  type: "wordcraft:request-save",
  protocol: 3,
  version: "fixture.3",
  openId: "open",
  documentId: "1",
  requestId: "request",
  reason: "automatic",
};

if (
  decodeNativeHostCommand(nativeCommand)?.type !== "wordcraft:request-save" ||
  decodeNativeHostCommand({ ...nativeCommand, unexpected: true }) !== null ||
  decodeNativeHostEvent(nativeCommand) !== null
)
  throw new Error("Packed native IPC export lost its strict command/event boundary.");

let requests = 0;

const sdkClient = createClient({
  baseUrl: "https://artifact.invalid/api/rpc",
  fetch: async (url, init) => {
    if (String(url) !== "https://artifact.invalid/api/rpc" || init?.method !== "POST")
      throw new Error("The packed client did not use its configured transport.");

    requests += 1;

    if (String(init.body) === JSON.stringify({ operation: "auth.status", input: {} }))
      return Response.json({ ok: true, value: { initialized: true, user: null } });

    if (String(init.body) === JSON.stringify({ operation: "editors.available", input: {} }))
      return Response.json({
        ok: true,
        value: {
          apps: [{ app: "wordcraft", version: "0.14.0", inputExtensions: [".docx"] }],
        },
      });

    throw new Error("The packed client did not derive the expected operation.");
  },
});

export function consumeInferredTypes(
  input: InputOf<typeof sdkClient.query.files.list>,
  output: OutputOf<typeof sdkClient.rpc.files.list>,
) {
  const name: string | undefined = output.items[0]?.name;

  // @ts-expect-error A packed consumer must retain operation input checking.
  sdkClient.query.files.list.getOptions({ parentId: 123 });
  // @ts-expect-error A packed consumer must retain result inference, not any.
  const invalid: number = output.items[0]!.name;

  return { name, invalid, options: sdkClient.query.files.list.getOptions(input) };
}

const editorBackend = sdkClient.editors.backend({ id: "file_artifact" });

export function consumeEditorResult(result: OutputOf<typeof editorBackend.save>) {
  if (result.status !== "saved") return result.status;
  const fileId: string = result.file.id;
  // @ts-expect-error The portable binding retains the authoritative saved-file type.
  const invalid: number = result.file.id;

  return { fileId, invalid };
}

let listeners = 0;
let posts = 0;

const messages = createBrowserEditorMessages({
  host: {
    addEventListener() {
      listeners += 1;
    },
    removeEventListener() {
      listeners -= 1;
    },
  },
  editorWindow: {
    postMessage() {
      posts += 1;
    },
  },
});

const unsubscribe = messages.subscribe(() => undefined);

const fixtureMessage = { type: "fixture", name: "fixture.docx", bytes: new Uint8Array([1]) };

messages.post(fixtureMessage, messages.origin);

let namedOriginRefused = false;

try {
  messages.post(fixtureMessage, "https://artifact.invalid");
} catch {
  namedOriginRefused = true;
}

unsubscribe();

if (listeners !== 0 || posts !== 1) throw new Error("Packed browser capability lifetime failed.");

if (messages.origin !== "null" || !namedOriginRefused)
  throw new Error("Packed browser capability addressed something other than a sandboxed frame.");

const status = await sdkClient.rpc.auth.status({});

const queryStatus = await sdkClient.query.auth.status
  .getOptions({})
  .queryFn({ signal: new AbortController().signal });

if (!status.initialized || status.user !== null || !queryStatus.initialized)
  throw new Error("The packed vanilla client did not decode its real operation response.");

const availability = await sdkClient.query.editors.available
  .getOptions({})
  .queryFn({ signal: new AbortController().signal });

if (
  availability.apps[0]?.app !== "wordcraft" ||
  availability.apps[0]?.version !== "0.14.0" ||
  !availability.apps[0]?.inputExtensions.includes(".docx") ||
  requests !== 3
)
  throw new Error("The packed client lost the generated editor availability query.");

sdkClient.dispose();

try {
  await sdkClient.rpc.auth.status({});
  throw new Error("The packed SDK ignored disposal.");
} catch (error) {
  if (!(error instanceof SDKError) || error.code !== "SDK_DISPOSED") throw error;
}

console.log(
  "PASS packed vanilla runtime, codecs, derived query, inference, and disposal (fake Fetch)",
);
