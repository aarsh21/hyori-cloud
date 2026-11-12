import { preloadCloudPath } from "@hyori-cloud/features/react";
import { createFileRoute } from "@tanstack/react-router";

import { CloudPage } from "@/app/cloud-page";

export const Route = createFileRoute("/$")({
  // CloudPage is the same shell on both routes; feature screens already split their own code.
  // Splitting this wrapper lets the router reload the document on a cold offline navigation.
  codeSplitGroupings: [],
  // Not awaited: this only starts the code download alongside the screen's first data request.
  loader: ({ location }) => preloadCloudPath(location.pathname),
  component: CloudPage,
});
