import { createRouter as createTanStackRouter } from "@tanstack/react-router";
import { createIsomorphicFn, getGlobalStartContext } from "@tanstack/react-start";
import { dehydrate, hydrate } from "@hyori-cloud/lib/query";

import { getAppRuntime } from "@/app/runtime";
import AppError from "@/components/app-error";
import AppNotFound from "@/components/app-not-found";
import Loader from "@/components/loader";
import { routeTree } from "@/routeTree.gen";

const requestNonce = createIsomorphicFn()
  .server(() => {
    // Standalone routers (including server-runtime tests) have no Start request context.
    try {
      return getGlobalStartContext()?.cspNonce;
    } catch {
      return undefined;
    }
  })
  .client(
    () =>
      document.querySelector('meta[property="csp-nonce"]')?.getAttribute("content") ?? undefined,
  );

export const getRouter = () => {
  const runtime = getAppRuntime();

  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: runtime,
    // SDK values are decoded JSON. A string keeps Query's unknown key/data types out of the
    // router serializer contract without asserting that arbitrary cache entries are serializable.
    dehydrate: () => ({ queryState: JSON.stringify(dehydrate(runtime.queryClient)) }),
    hydrate: (state) => {
      hydrate(runtime.queryClient, JSON.parse(state.queryState));
    },
    // Hydration captures this at router creation, before route loaders or rendering run.
    ssr: { nonce: requestNonce() },
    defaultPendingComponent: () => <Loader />,
    defaultErrorComponent: () => <AppError />,
    defaultNotFoundComponent: () => <AppNotFound />,
  });

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
