import { normalizeClientError } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";
import { useMutationState, useQueryClient } from "@hyori-cloud/lib/query";
import type { QueryKey } from "@hyori-cloud/lib/query";
import type { FileActionScope } from "#features/files/react/file-action-scope.ts";
import { useAccessRecoveryPolicy } from "#features/shared/react/access-recovery.tsx";
import { describeCloudError } from "#features/shared/cloud-error.ts";

const isItemTarget = Schema.is(Schema.Struct({ id: Schema.String }));

/** Notices are owner-scoped; identical visible feedback is acknowledged together. */
export function useFileActionErrors(scope: FileActionScope) {
  const queryClient = useQueryClient();
  const cache = queryClient.getMutationCache();
  const recoveryPolicy = useAccessRecoveryPolicy();

  const failures = useMutationState({
    filters: {
      status: "error",
      predicate: (value) => value.options.meta?.fileActionsOwner === scope.fileActionsOwner,
    },
    select: (value) => value,
  });

  const shown = failures[0];
  const error = shown ? normalizeClientError(shown.state.error) : null;

  return {
    error,
    dismiss() {
      if (error === null) return;
      const shownRecovery = recoveryPolicy(error);
      const shownCopy = shownRecovery ?? describeCloudError(error);

      for (const failed of cache.findAll({
        status: "error",
        predicate: (value) => value.options.meta?.fileActionsOwner === scope.fileActionsOwner,
      })) {
        const current = normalizeClientError(failed.state.error);
        const recovery = recoveryPolicy(current);
        const copy = recovery ?? describeCloudError(current);

        if (
          copy.title === shownCopy.title &&
          copy.detail === shownCopy.detail &&
          recovery?.actionLabel === shownRecovery?.actionLabel
        )
          cache.remove(failed);
      }
    },
    recovered() {
      for (const failed of cache.findAll({
        status: "error",
        predicate: (value) => value.options.meta?.fileActionsOwner === scope.fileActionsOwner,
      }))
        if (recoveryPolicy(normalizeClientError(failed.state.error)) !== null) cache.remove(failed);
    },
    clearFor(key: QueryKey, id: string) {
      for (const failed of cache.findAll({
        mutationKey: key,
        status: "error",
        predicate: (value) =>
          value.options.meta?.fileActionsOwner === scope.fileActionsOwner &&
          isItemTarget(value.state.variables) &&
          value.state.variables.id === id,
      }))
        cache.remove(failed);
    },
  };
}
