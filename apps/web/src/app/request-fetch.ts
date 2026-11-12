import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import type { FetchCapability } from "@hyori-cloud/client-sdk";
import { ENV } from "@/env";
import { handleApiRequest } from "@/server/api";
import { renderRequest } from "@/app/render-request";

/** SSR uses the same authority-checked proxy as browser RPC, with only this request's cookies. */
export const requestFetch: FetchCapability = createIsomorphicFn()
  .server(async (_input, init) => {
    return handleApiRequest(renderRequest(getRequest(), init, ENV.APP_ORIGIN));
  })
  .client((input, init) => globalThis.fetch(input, init));
