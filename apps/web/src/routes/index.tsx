import { CloudPage } from "@/app/cloud-page";
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/")({
  component: CloudPage,
});
