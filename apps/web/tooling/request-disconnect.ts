import type { Connect, Plugin } from "vite";
import { z } from "zod";

const cancelledIncomingRequest = z.object({
  code: z.literal("ECONNRESET"),
  message: z.literal("aborted"),
});

/** Nitro's dev bridge forwards Node request-body disconnects to Vite's error/HMR handler. */
export function requestDisconnectBoundary(): Plugin {
  return {
    name: "hyori-request-disconnect",
    apply: "serve",
    enforce: "post",
    configureServer(server) {
      // Register after Nitro's post middleware, but before Vite's final error handler.
      return () => {
        const onError: Connect.ErrorHandleFunction = (error, request, response, next) => {
          if (
            (request.aborted || response.destroyed) &&
            cancelledIncomingRequest.safeParse(error).success
          ) {
            response.destroy();

            return;
          }

          next(error);
        };

        server.middlewares.use(onError);
      };
    },
  };
}
