import { createFileRoute } from "@tanstack/react-router";

import { CloudPage } from "@/app/cloud-page";

export const Route = createFileRoute("/$")({
  component: CloudPage,
});
