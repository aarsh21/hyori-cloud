import type { QueryClient } from "@hyori-cloud/lib/query-core";
import type { Client } from "#client-sdk/client";
import type { EditorBackendOptions } from "#client-sdk/features/editors/create-editors";
import type { EditorBackendPort } from "#client-sdk/features/editors/editor-contract";
import { reconcileMutation } from "#client-sdk/mutation-defaults";

/** Frame subscriptions own save state; the generated completion policy owns shared cache refresh. */
export function createQueryEditorBackend(
  sdkClient: Client,
  queryClient: QueryClient,
  options: EditorBackendOptions,
  onReconciliationError: (cause: unknown) => void = () => {
    console.error("Editor output was saved, but refreshing cached views failed.");
  },
) {
  const backend = sdkClient.editors.backend(options);

  return {
    ...backend,
    async save(input, context) {
      const result = await backend.save(input, context);

      if (result.status === "saved") {
        // Cache/observer failures cannot turn a confirmed commit into an ambiguous server save.
        void reconcileMutation(queryClient, sdkClient.mutation.editors.completeSave.key).catch(
          (cause) => {
            try {
              onReconciliationError(cause);
            } catch {
              console.error("Editor output was saved, but its cache-error observer failed.");
            }
          },
        );
      }

      return result;
    },
  } satisfies EditorBackendPort;
}
