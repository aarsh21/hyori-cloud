import { createNodeBackendProxy } from "@hyori-cloud/api/node";

type WebBackendConfig = {
  origin: string;
  backendUrl: string | undefined;
  production: boolean;
};

function unavailable(): Response {
  return Response.json(
    {
      ok: false,
      error: {
        code: "service.unavailable",
        message: "Server configuration is incomplete. Configure the private Rust backend.",
      },
    },
    { status: 503, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

/** The app owns public HTTPS-to-private HTTP authority mapping, never forwarded-header trust. */
export function createWebBackendHandler(config: WebBackendConfig) {
  try {
    if (!config.backendUrl) throw new Error("Missing private backend origin");
    const origin = new URL(config.origin);

    if (config.production && origin.protocol !== "https:")
      throw new Error("Production requires an HTTPS public origin");
    const proxy = createNodeBackendProxy({ origin: config.origin, backendUrl: config.backendUrl });

    return (request: Request): Promise<Response> => {
      // TLS terminates at the gateway. It must preserve the public Host on its private hop.
      // Request.url may be synthesized by the host framework; it is not authority evidence.
      if (request.headers.get("host") !== origin.host)
        return Promise.resolve(
          Response.json(
            {
              ok: false,
              error: { code: "access.denied", message: "Unexpected request authority" },
            },
            { status: 403, headers: { "Cache-Control": "no-store" } },
          ),
        );
      const incoming = new URL(request.url);
      const target = new URL(`${incoming.pathname}${incoming.search}`, origin);

      return proxy(new Request(target, request));
    };
  } catch {
    return async (_request: Request): Promise<Response> => unavailable();
  }
}
