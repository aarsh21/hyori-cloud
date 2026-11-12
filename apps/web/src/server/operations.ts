import { ServerResponse } from "node:http";
import { z } from "zod";

const nodeResponse = z.object({
  runtime: z.object({ node: z.object({ res: z.instanceof(ServerResponse) }) }),
});

const methods = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);

/** Fixed categories only: even a malformed URL or method must not become log content. */
function routeKind(path: string) {
  if (path === "/health/live" || path === "/health/ready") return "health";

  if (path === "/api/rpc") return "rpc";

  if (path.startsWith("/api/storage/")) return "storage";

  if (path.startsWith("/assets/") || path.startsWith("/artcraft/")) return "asset";

  return "page";
}

/** Wrap the entire Nitro host, including static assets, rejected requests and streamed responses. */
export function withOperations(
  next: (request: Request) => Response | Promise<Response>,
  backendUrl: string | undefined,
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
) {
  return async (request: Request): Promise<Response> => {
    const started = performance.now();
    const path = new URL(request.url).pathname;
    let status = 500;
    let logged = false;

    const log = () => {
      if (logged) return;
      logged = true;
      write(
        JSON.stringify({
          event: "web_request",
          method: methods.has(request.method) ? request.method : "OTHER",
          route: routeKind(path),
          status,
          duration_ms: Math.round((performance.now() - started) * 100) / 100,
        }),
      );
    };

    const node = nodeResponse.safeParse(request);

    if (node.success) {
      const response = node.data.runtime.node.res;
      response.once("finish", log);
      response.once("close", () => {
        if (!response.writableFinished) status = 499;
        log();
      });
    }

    // Native Requests made by SSR/serverFetch have no Node response. They are not incoming traffic.
    let response: Response;

    if (path === "/health/live" || path === "/health/ready") {
      let ready = path === "/health/live";

      if (!ready && backendUrl) {
        try {
          const upstream = await fetch(new URL("/health/ready", backendUrl), {
            signal: AbortSignal.timeout(2000),
            redirect: "error",
            cache: "no-store",
          });

          ready = upstream.status === 200;
          await upstream.body?.cancel();
        } catch {
          ready = false;
        }
      }

      response = new Response(request.method === "HEAD" ? null : ready ? "ok\n" : "unavailable\n", {
        status: ready ? 200 : 503,
        headers: {
          "Cache-Control": "no-store",
          "Content-Type": "text/plain",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } else response = await next(request);
    status = response.status;

    return response;
  };
}
