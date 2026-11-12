import { createServerOnlyFn } from "@tanstack/react-start";

import { ENV } from "@/env";
import { createWebBackendHandler } from "@/server/backend-handler";

let apiHandler: ReturnType<typeof createWebBackendHandler> | undefined;

export const handleApiRequest = createServerOnlyFn(async (request: Request): Promise<Response> => {
  apiHandler ??= createWebBackendHandler({
    origin: ENV.APP_ORIGIN,
    backendUrl: ENV.HYORI_BACKEND_URL,
    production: ENV.APP_ENV === "production",
    gatewayClientAddressHeader: ENV.HYORI_GATEWAY_CLIENT_ADDRESS_HEADER,
  });

  return apiHandler(request);
});
