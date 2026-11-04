import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { getAppRuntime } from "@/app/runtime";
import Loader from "@/components/loader";
import { routeTree } from "@/routeTree.gen";

export const getRouter = () => {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: getAppRuntime(),
    defaultPendingComponent: () => <Loader />,
    defaultNotFoundComponent: () => <div>Not Found</div>,
  });

  return router;
};

declare module "@tanstack/react-router" {
  interface Register {
    router: ReturnType<typeof getRouter>;
  }
}
