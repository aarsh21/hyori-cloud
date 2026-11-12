import { createBackendProxy, type BackendProxyConfig } from "#api/backend-proxy";
import { requestNodeBackend } from "#api/node-request";

export function createNodeBackendProxy(config: Omit<BackendProxyConfig, "request">) {
  const proxy = createBackendProxy({ ...config, request: requestNodeBackend });

  return async (request: Request, rawHeaders?: readonly string[]): Promise<Response> => {
    const response = await proxy(request, rawHeaders);

    // An early PUT rejection can cancel an unfinished Node request body. Its HTTP/1 connection
    // must not be reused with unread bytes by the gateway for the next RPC.
    if (request.method === "PUT" && !response.ok) response.headers.set("connection", "close");

    return response;
  };
}
