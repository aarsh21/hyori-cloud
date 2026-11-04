import { createFileRoute } from "@tanstack/react-router";

import { handleApiRequest } from "@/server/api";

export const Route = createFileRoute("/api/rpc")({
  server: {
    handlers: {
      POST: ({ request }) => handleApiRequest(request),
    },
  },
});
