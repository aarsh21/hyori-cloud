import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";

export function useSetup() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.auth.setup.mutationOptions());
}
