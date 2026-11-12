import { CloudPage } from "@/app/cloud-page";
import { loadPage } from "@/app/load-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  codeSplitGroupings: [],
  loader: ({ context, location }) => loadPage(context, location.pathname),
  head: ({ loaderData }) => ({
    links: loaderData?.preloads.map((href) => ({ rel: "modulepreload", href })),
  }),
  component: CloudPage,
});
