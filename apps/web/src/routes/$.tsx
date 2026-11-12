import { loadPage } from "@/app/load-page";
import { createFileRoute } from "@tanstack/react-router";

import { CloudPage } from "@/app/cloud-page";

export const Route = createFileRoute("/$")({
  // CloudPage is the same shell on both routes; feature screens already split their own code.
  // Splitting this wrapper lets the router reload the document on a cold offline navigation.
  codeSplitGroupings: [],
  loader: ({ context, location }) => loadPage(context, location.pathname),
  head: ({ loaderData }) => ({
    links: loaderData?.preloads.map((href) => ({ rel: "modulepreload", href })),
  }),
  component: CloudPage,
});
