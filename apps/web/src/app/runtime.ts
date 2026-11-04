import { createClient } from "@hyori-cloud/client-sdk";
import { setMutationDefaults } from "@hyori-cloud/client-sdk/react";
import { QueryClient } from "@hyori-cloud/lib/query";

export function createAppRuntime() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 15_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: { retry: false },
    },
  });

  setMutationDefaults(queryClient);
  const sdkClient = createClient({ baseUrl: "/api/rpc" });

  return { queryClient, sdkClient };
}

let browserRuntime: ReturnType<typeof createAppRuntime> | undefined;

export function getAppRuntime() {
  if (typeof window === "undefined") return createAppRuntime();
  browserRuntime ??= createAppRuntime();

  return browserRuntime;
}
