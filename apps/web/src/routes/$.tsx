import { preloadCloudPath } from "@hyori-cloud/features/react";
import { createFileRoute } from "@tanstack/react-router";

import { CloudPage } from "@/app/cloud-page";

export const Route = createFileRoute("/$")({
  // Not awaited: this only starts the code download alongside the screen's first data request.
  loader: ({ location }) => preloadCloudPath(location.pathname),
  component: CloudPage,
});
