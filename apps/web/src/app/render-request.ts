import { z } from "zod";

const nodeEvidence = z.object({
  runtime: z.object({ node: z.object({ req: z.object({ rawHeaders: z.array(z.string()) }) }) }),
});

/** Preserve the visitor's authority, cookie, raw gateway-header evidence and cancellation. */
export function renderRequest(incoming: Request, init: RequestInit | undefined, origin: string) {
  const evidence = nodeEvidence.safeParse(incoming);
  const headers = new Headers(incoming.headers);
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.set("content-type", "application/json");
  headers.set("origin", new URL(origin).origin);
  headers.set("sec-fetch-site", "same-origin");

  return Object.assign(
    new Request(new URL("/api/rpc", origin), {
      ...init,
      headers,
      signal: init?.signal ? AbortSignal.any([incoming.signal, init.signal]) : incoming.signal,
    }),
    { runtime: evidence.success ? evidence.data.runtime : undefined },
  );
}
