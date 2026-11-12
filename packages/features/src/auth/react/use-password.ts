import { useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useMutation } from "@hyori-cloud/lib/query";

export function useChangePassword() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.auth.changePassword.mutationOptions());
}

export function useResetPassword() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.auth.resetPassword.mutationOptions());
}

export function useCreatePasswordReset() {
  const { mutation } = useClientSDK();

  return useMutation(mutation.admin.createPasswordReset.mutationOptions());
}
