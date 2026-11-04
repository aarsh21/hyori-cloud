import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";

export function useLogin() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.auth.login.mutationOptions());
}
