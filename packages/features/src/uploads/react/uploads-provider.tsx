import type { UploadQueue } from "@hyori-cloud/client-sdk";
import { createQueryUploadQueue, useClientSDK } from "@hyori-cloud/client-sdk/react";
import { useQueryClient } from "@hyori-cloud/lib/query";
import { createContext, use, useState } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import { useDisposeOnUnmount } from "@hyori-cloud/ui/hooks/use-dispose-on-unmount";
import { createBrowserListStore } from "@hyori-cloud/ui/lib/browser-list-store";

const UploadsContext = createContext<UploadQueue | null>(null);

/**
 * Mounts the SDK's queue for one person's session. A null scope keeps nothing in the browser, so
 * anonymous link uploads can't be revealed to the next person using a shared computer.
 */
export function UploadsProvider({
  scope,
  children,
}: {
  scope: string | null;
  children: ReactNode;
}) {
  const sdkClient = useClientSDK();
  const queryClient = useQueryClient();

  const [queue] = useState(() =>
    createQueryUploadQueue(
      sdkClient,
      queryClient,
      createBrowserListStore(scope === null ? null : `hyori.uploads.${scope}`),
    ),
  );

  useDisposeOnUnmount(queue.dispose);

  return <UploadsContext value={queue}>{children}</UploadsContext>;
}

export function useUploadQueue(): UploadQueue {
  const queue = use(UploadsContext);

  if (queue === null) throw new Error("useUploadQueue requires UploadsProvider.");

  return queue;
}
