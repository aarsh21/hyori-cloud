import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { pipeline } from "node:stream/promises";
import { nodeRequestBody } from "#api/node-request-body";
import { nodeResponseStream } from "#api/node-response-stream";

/** Node Fetch rewrites Host to the private destination; this transport preserves configured authority. */
export function requestNodeBackend(request: Request): Promise<Response> {
  return new Promise((resolve, reject) => {
    const target = new URL(request.url);
    const send = target.protocol === "https:" ? httpsRequest : httpRequest;

    const outgoing = send(
      target,
      {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        signal: request.signal,
      },
      (incoming) => {
        const headers = new Headers();

        for (let index = 0; index < incoming.rawHeaders.length; index += 2)
          headers.append(incoming.rawHeaders[index]!, incoming.rawHeaders[index + 1]!);
        const status = incoming.statusCode ?? 502;

        const body = [204, 205, 304].includes(status)
          ? null
          : nodeResponseStream(incoming, headers);

        if (!body) incoming.resume();
        resolve(new Response(body, { status, statusText: incoming.statusMessage, headers }));
      },
    );

    outgoing.once("error", reject);

    if (request.body) void pipeline(nodeRequestBody(request.body), outgoing).catch(reject);
    else outgoing.end();
  });
}
