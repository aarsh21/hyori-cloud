import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";

/** Waits before each retry of a sign-in the server answered as busy, about 3 s in all. */
const BUSY_RETRY_DELAYS_MS = [250, 500, 1000, 1500];

export function useLogin() {
  const { mutation } = useClientSDK();

  return useMutation({
    ...mutation.auth.login.mutationOptions(),
    // A busy answer checked no password and spent no attempt, so retrying it is safe; the person
    // sees a message only if the lane stays full for every retry.
    retry: (failures, error) =>
      error.code === "auth.signInBusy" && failures < BUSY_RETRY_DELAYS_MS.length,
    retryDelay: (failures) => BUSY_RETRY_DELAYS_MS[failures] ?? 1500,
  });
}
