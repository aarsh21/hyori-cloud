import { createClient, type EditorSession, type OutputOf } from "@hyori-cloud/client-sdk";
import {
  ClientSDKProvider,
  createQuery,
  createQueryEditorBackend,
  setMutationDefaults,
  useClientSDK,
  useEditorSession,
  type ResourceOf,
} from "@hyori-cloud/client-sdk/react";
import { createQueryClient, useQuery } from "@hyori-cloud/lib/query";

const sdkClient = createClient({
  baseUrl: "https://artifact.invalid/api/rpc",
  fetch: async () => Response.json({ ok: true, value: { initialized: true, user: null } }),
});

const queryClient = createQueryClient();

setMutationDefaults(queryClient);

const query = createQuery(sdkClient);
const editorBackend = createQueryEditorBackend(sdkClient, queryClient, { id: "file_artifact" });

export function useArtifactEditor(session: EditorSession) {
  return useEditorSession(session);
}

export function consumeEditorResult(result: OutputOf<typeof editorBackend.save>) {
  if (result.status !== "saved") return result.status;
  const fileId: string = result.file.id;
  // @ts-expect-error Query cache integration must not erase saved-file inference.
  const invalid: number = result.file.id;

  return { fileId, invalid };
}

export function useArtifactStatus(): ResourceOf<typeof query.auth.status> {
  return useQuery(useClientSDK().query.auth.status.getOptions({}));
}

export const providerProps: Parameters<typeof ClientSDKProvider>[0] = {
  sdkClient,
  children: null,
};

export function checkResourceInference(resource: ResourceOf<typeof query.auth.status>) {
  if (resource.data) {
    const initialized: boolean = resource.data.initialized;

    // @ts-expect-error The packed React resource must not degrade to any.
    const invalid: number = resource.data.initialized;

    return { initialized, invalid };
  }

  return null;
}

const status = await queryClient.fetchQuery(query.auth.status.getOptions({}));

if (!status.initialized || status.user !== null || providerProps.sdkClient !== sdkClient)
  throw new Error("The packed React entry or its declared Query peer did not execute.");

queryClient.clear();

sdkClient.dispose();

console.log(
  "PASS packed React entry, declared peers, inferred resources, and Query execution (fake Fetch)",
);
