import { createFileRoute } from "@tanstack/react-router";

import { handleApiRequest } from "@/server/api";

export const Route = createFileRoute("/api/storage/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleApiRequest(request),
      PUT: ({ request }) => handleApiRequest(request),
      HEAD: ({ request }) => handleApiRequest(request),
    },
  },
});
