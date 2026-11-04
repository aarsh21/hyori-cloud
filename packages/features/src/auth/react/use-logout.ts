import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";

export function useLogout() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.auth.logout.mutationOptions());
}
