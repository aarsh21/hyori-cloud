import { createBackendProxy, type BackendProxyConfig } from "#api/backend-proxy";
import { requestNodeBackend } from "#api/node-request";

export function createNodeBackendProxy(config: Omit<BackendProxyConfig, "request">) {
  return createBackendProxy({ ...config, request: requestNodeBackend });
}
