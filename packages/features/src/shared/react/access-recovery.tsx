import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQueryClient } from "@hyori-cloud/lib/query";
import { createContext, useContext } from "@hyori-cloud/lib/react";
import { Button } from "@hyori-cloud/ui/components/button";
import { describeCloudError } from "#features/shared/cloud-error.ts";
import type { CloudError } from "#features/shared/cloud-error.ts";

export type AccessRecovery = {
  readonly title: string;
  readonly detail?: string;
  readonly actionLabel: string;
  readonly pendingLabel: string;
  readonly pending: boolean;
  readonly recover: (onRecovered?: () => void) => void;
};

/** Decides whether a failure means access itself ended, and how to get it back. */
export type AccessRecoveryPolicy = (error: CloudError) => AccessRecovery | null;

const AccessRecoveryContext = createContext<AccessRecoveryPolicy | null>(null);

/** Surfaces that aren't backed by an account mount their own policy; the default is signing in. */
export const AccessRecoveryProvider = AccessRecoveryContext;

/**
 * Refetching can't fix a lost session, so every failure surface offers this instead of a retry that
 * would keep failing. Only AuthBoundary observes `auth.status`, which is what makes sign-in appear.
 */
export function useAccessRecoveryPolicy(): AccessRecoveryPolicy {
  const policy = useContext(AccessRecoveryContext);
  const { query } = useClientSDK();
  const queryClient = useQueryClient();

  if (policy !== null) return policy;

  return (error) => {
    if (error.code !== "auth.required") return null;

    return {
      ...describeCloudError(error),
      actionLabel: "Sign in",
      pendingLabel: "Signing in…",
      pending: false,
      recover: () => void queryClient.invalidateQueries({ queryKey: query.auth.status.key }),
    };
  };
}

export function useAccessRecovery(error: CloudError | null): AccessRecovery | null {
  const policy = useAccessRecoveryPolicy();

  return error === null ? null : policy(error);
}

export function AccessRecoveryButton({
  recovery,
  size,
  onRecovered,
}: {
  recovery: AccessRecovery;
  size?: "lg" | "default" | "sm" | "xs";
  onRecovered?: () => void;
}) {
  return (
    <Button
      type="button"
      size={size}
      variant="outline"
      pending={recovery.pending}
      pendingLabel={recovery.pendingLabel}
      onClick={() => recovery.recover(onRecovered)}
    >
      {recovery.actionLabel}
    </Button>
  );
}
