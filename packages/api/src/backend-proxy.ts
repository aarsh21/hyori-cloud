type BackendRequest = (request: Request) => Promise<Response>;

export type BackendProxyConfig = {
  origin: string;
  backendUrl: string;
  request?: BackendRequest;
};

const hopHeaders = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
];

function endToEndHeaders(source: Headers): Headers {
  const headers = new Headers(source);
  const nominated = source.get("connection")?.split(",") ?? [];

  for (const name of [...hopHeaders, ...nominated]) {
    const trimmed = name.trim();

    if (trimmed) headers.delete(trimmed);
  }

  return headers;
}

function failure(status: number, code: string, message: string): Response {
  return Response.json(
    { ok: false, error: { code, message } },
    { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } },
  );
}

function configuredOrigin(value: string): URL {
  const url = new URL(value);

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new Error("Backend proxy URLs must be HTTP(S) origins without credentials or paths");

  return url;
}

/** Streams only the product API to an operator-configured backend; never follows redirects. */
export function createBackendProxy(config: BackendProxyConfig): BackendRequest {
  const origin = configuredOrigin(config.origin);
  const backend = configuredOrigin(config.backendUrl);
  const requestBackend = config.request ?? fetch;

  return async (request) => {
    const url = new URL(request.url);

    if (
      url.origin !== origin.origin ||
      (request.headers.has("origin") && request.headers.get("origin") !== origin.origin) ||
      request.headers.get("sec-fetch-site") === "cross-site"
    )
      return failure(403, "access.denied", "Cross-origin access is not allowed");

    const isRpc = url.pathname === "/api/rpc";
    const isStorage = url.pathname.startsWith("/api/storage/");

    if (!isRpc && !isStorage) return failure(404, "resource.notFound", "Endpoint not found");

    if (
      (isRpc && request.method !== "POST") ||
      (isStorage && !["GET", "PUT"].includes(request.method))
    )
      return failure(405, "input.invalid", "Method not allowed");

    if (
      request.method !== "GET" &&
      request.headers.has("cookie") &&
      !request.headers.has("origin") &&
      !["same-origin", "none"].includes(request.headers.get("sec-fetch-site") ?? "")
    )
      return failure(
        403,
        "access.denied",
        "Cookie-authenticated writes require the configured Origin",
      );

    const headers = endToEndHeaders(request.headers);

    for (const name of request.headers.keys())
      if (name === "forwarded" || name.startsWith("x-forwarded-") || name === "x-real-ip")
        headers.delete(name);

    // The private backend sees the configured public host, never caller-supplied proxy evidence.
    headers.set("host", origin.host);
    headers.set("accept-encoding", "identity");
    const target = new URL(`${url.pathname}${url.search}`, backend);

    const init: RequestInit & { duplex: "half" } = {
      method: request.method,
      headers,
      signal: request.signal,
      redirect: "manual",
      duplex: "half",
    };

    if (request.method !== "GET") init.body = request.body;

    try {
      const response = await requestBackend(new Request(target, init));
      const outgoing = endToEndHeaders(response.headers);
      outgoing.set("cache-control", "private, no-store");
      outgoing.set("x-content-type-options", "nosniff");

      // Fetch decodes these encodings; their wire lengths no longer describe the returned stream.
      if (/^(gzip|deflate|br)$/i.test(outgoing.get("content-encoding") ?? "")) {
        outgoing.delete("content-encoding");
        outgoing.delete("content-length");
      }

      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: outgoing,
      });
    } catch (error) {
      if (request.signal.aborted) throw error;

      return failure(503, "service.unavailable", "The backend is unavailable; retry shortly");
    }
  };
}
