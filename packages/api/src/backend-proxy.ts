import { isIP } from "node:net";

type BackendRequest = (request: Request) => Promise<Response>;

export type BackendProxyConfig = {
  origin: string;
  backendUrl: string;
  gatewayClientAddressHeader?: string;
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

const rpcCompressionHeader = "x-hyori-rpc-compressible";
const rpcNoStore = "private, no-store, no-transform";
const minRpcCompressionBytes = 1024;

function rpcEncoding(header: string | null) {
  if (!header) return "identity";

  const weights = new Map<string, number>();

  for (const entry of header.split(",")) {
    const [token, ...parameters] = entry.trim().split(";");
    const coding = token?.trim().toLowerCase();

    if (coding !== "gzip" && coding !== "identity" && coding !== "*") continue;

    const quality = /^q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/i.exec(parameters[0]?.trim() ?? "");

    const weight =
      parameters.length === 0 ? 1 : parameters.length === 1 && quality ? Number(quality[1]) : 0;

    // Conflicting duplicate entries must not override a client's explicit refusal.
    weights.set(coding, Math.min(weights.get(coding) ?? 1, weight));
  }

  const wildcard = weights.get("*");
  const gzip = weights.get("gzip") ?? wildcard ?? 0;
  const identity = weights.get("identity");

  // Unweighted identity is a fallback, not a preference over an accepted coding.
  if (gzip > 0 && gzip >= (identity ?? 0)) return "gzip";

  if ((identity ?? (wildcard === 0 ? 0 : 1)) > 0) return "identity";

  return null;
}

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
export function createBackendProxy(config: BackendProxyConfig) {
  const origin = configuredOrigin(config.origin);
  const backend = configuredOrigin(config.backendUrl);
  const requestBackend = config.request ?? fetch;
  const addressHeader = config.gatewayClientAddressHeader?.toLowerCase() || undefined;

  if (
    addressHeader &&
    (!/^[!#$%&'*+.^_`|~0-9a-z-]+$/.test(addressHeader) ||
      addressHeader === "x-hyori-client-address")
  )
    throw new Error("Gateway client address header must name a separate HTTP header");

  // rawHeaders must come from the host's HTTP runtime, never from another request header.
  return async (request: Request, rawHeaders?: readonly string[]): Promise<Response> => {
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

    // Axum answers HEAD on every GET route, so storage metadata checks pass through unchanged.
    const isRead = request.method === "GET" || request.method === "HEAD";

    if ((isRpc && request.method !== "POST") || (isStorage && !isRead && request.method !== "PUT"))
      return failure(405, "input.invalid", "Method not allowed");

    if (
      !isRead &&
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
    // Correlation IDs are issued by the private backend, never provided by the public caller.
    headers.delete("x-request-id");
    headers.delete(rpcCompressionHeader);

    for (const name of request.headers.keys())
      if (
        name === "forwarded" ||
        name.startsWith("x-forwarded-") ||
        name === "x-real-ip" ||
        name === "x-hyori-client-address"
      )
        headers.delete(name);

    if (addressHeader) {
      const value = request.headers.get(addressHeader);

      const occurrences = rawHeaders?.filter(
        (name, index) => index % 2 === 0 && name.toLowerCase() === addressHeader,
      ).length;

      // Fetch folds duplicate physical fields into a comma list. Without raw evidence, fail
      // closed on lists rather than confuse duplicated fields with one gateway-appended chain.
      if (value && (occurrences === 1 || (occurrences === undefined && !value.includes(",")))) {
        const address = value.split(",").at(-1)?.trim();

        if (address && !address.includes("%") && isIP(address))
          headers.set("x-hyori-client-address", address);
      }
    }

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

    if (!isRead) init.body = request.body;

    try {
      const response = await requestBackend(new Request(target, init));
      const outgoing = endToEndHeaders(response.headers);
      const compressible = outgoing.get(rpcCompressionHeader) === "1";
      const upstreamEncoding = outgoing.get("content-encoding");
      outgoing.delete(rpcCompressionHeader);

      // Only authorized thumbnail/preview responses opt into storage with mandatory revalidation.
      // Never relax RPC, originals, errors, or an unrecognized backend cache policy.
      const revalidatedMedia =
        isRead &&
        /^\/api\/storage\/(derivatives|previews)\//.test(url.pathname) &&
        [200, 206, 304].includes(response.status) &&
        outgoing.get("cache-control") === "private, no-cache" &&
        outgoing.has("etag");

      outgoing.set(
        "cache-control",
        isRpc ? rpcNoStore : revalidatedMedia ? "private, no-cache" : "private, no-store",
      );
      outgoing.set("x-content-type-options", "nosniff");

      let body = response.body;

      // Only the private Rust handler can opt in a successful, cookie-free JSON response.
      if (
        isRpc &&
        compressible &&
        response.status === 200 &&
        body &&
        outgoing.get("content-type") === "application/json" &&
        !outgoing.has("set-cookie") &&
        upstreamEncoding === null &&
        !outgoing.has("content-range") &&
        Number(outgoing.get("content-length")) >= minRpcCompressionBytes
      ) {
        outgoing.append("vary", "Accept-Encoding");
        const encoding = rpcEncoding(request.headers.get("accept-encoding"));

        if (encoding === null) {
          await body.cancel();
          const rejected = failure(406, "input.invalid", "No acceptable RPC content encoding");
          rejected.headers.set("cache-control", rpcNoStore);
          rejected.headers.set("vary", outgoing.get("vary") ?? "Accept-Encoding");

          return rejected;
        }

        if (encoding === "gzip") {
          outgoing.delete("content-length");
          outgoing.set("content-encoding", "gzip");
          body = body.pipeThrough(new CompressionStream("gzip"));
        }
      }

      // Fetch decodes these encodings; their wire lengths no longer describe the returned stream.
      if (/^(gzip|deflate|br)$/i.test(upstreamEncoding ?? "")) {
        outgoing.delete("content-encoding");
        outgoing.delete("content-length");
      }

      return new Response(body, {
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
