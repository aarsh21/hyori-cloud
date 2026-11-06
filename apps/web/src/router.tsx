import { createRouter as createTanStackRouter } from "@tanstack/react-router";

import { getAppRuntime } from "@/app/runtime";
import AppError from "@/components/app-error";
import AppNotFound from "@/components/app-not-found";
import Loader from "@/components/loader";
import { routeTree } from "@/routeTree.gen";

export const getRouter = () => {
  const router = createTanStackRouter({
    routeTree,
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
    context: getAppRuntime(),
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
