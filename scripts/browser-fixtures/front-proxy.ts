import { lstatSync } from "node:fs";
import http2 from "node:http2";
import { extname, resolve, sep } from "node:path";
import { z } from "zod";
import { editorContentSecurityPolicy } from "../editor-csp.ts";

export type ProxyRecord = {
  readonly at: number;
  readonly protocol: "http/1.1" | "h2";
  readonly method: string;
  readonly path: string;
  readonly operation: string | null;
  readonly rpcBody: string | null;
  readonly range: string | null;
  status: number;
  bytes: number;
  contentRange: string | null;
  contentLength: string | null;
  contentType: string | null;
  cacheControl: string | null;
  durationMs: number;
  outcome: "pending" | "complete" | "aborted" | "dropped" | "abandoned";
  /** Why the gateway got no reply from Nitro, and whether the browser had already gone. */
  failure: string | null;
  /** An RPC error reply as the host sent it, so a conflict can be traced to its exact code. */
  errorBody: string | null;
};

/** What the gateway saw below HTTP semantics. Observed only: nothing here changes a response. */
export type TransportEvent = {
  readonly at: number;
  readonly kind: string;
  readonly detail: string;
};

/** A fault at this transport, in front of the real backend. The backend itself is never faked. */
type Fault = {
  readonly matches: (record: ProxyRecord) => boolean;
  readonly action:
    | { readonly kind: "hold"; readonly released: Promise<void> }
    | { readonly kind: "replace-reply"; readonly status: number }
    | { readonly kind: "drop-reply" }
    | {
        readonly kind: "abandon-request";
        readonly afterMs: number;
        readonly replyStarted: boolean;
      }
    | { readonly kind: "rewrite-reply"; readonly transform: (body: string) => string }
    | { readonly kind: "refuse"; readonly status: number }
    | { readonly kind: "stall-body"; readonly released: Promise<void> };
  remaining: number;
};

const RpcEnvelope = z.object({ operation: z.string() });

function rpcOperation(body: string) {
  try {
    return RpcEnvelope.safeParse(JSON.parse(body)).data?.operation ?? null;
  } catch {
    return null;
  }
}

const HOP_HEADERS = ["connection", "keep-alive", "transfer-encoding", "upgrade", "te", "trailer"];

/**
 * Only for this private test host: terminates TLS, records traffic, and can break a reply in transit,
 * as a gateway in front of the web host would see it. Every path goes to the real Nitro server, so its
 * own adapter is what reaches the private Rust backend. This fixture never talks to Rust directly.
 */
const STATIC_PREFIX = "/artcraft/";

const STATIC_TYPES = new Map([
  [".wasm", "application/wasm"],
  [".js", "text/javascript"],
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css"],
  [".ico", "image/x-icon"],
  [".json", "application/json"],
  [".md", "text/markdown; charset=utf-8"],
]);

/**
 * The same route and headers as `docs/editor-deployment.md` gives Caddy, ahead of the host, with the
 * policy derived from this bundle by the same owner. Only compression differs: Caddy gzips, and this
 * serves identity, so nothing here measures transfer size.
 */
function staticResponse(root: string, contentSecurityPolicy: string, pathname: string) {
  const directory = resolve(root);

  const path = resolve(
    directory,
    `.${decodeURIComponent(pathname.slice(STATIC_PREFIX.length - 1))}`,
  );

  if (!path.startsWith(`${directory}${sep}`)) return new Response("Not found", { status: 404 });

  const file = lstatSync(path, { throwIfNoEntry: false });

  if (file === undefined || !file.isFile()) return new Response("Not found", { status: 404 });

  return new Response(Bun.file(path), {
    headers: {
      "content-type": STATIC_TYPES.get(extname(path)) ?? "application/octet-stream",
      "content-length": String(file.size),
      "x-content-type-options": "nosniff",
      "x-frame-options": "SAMEORIGIN",
      "content-security-policy": contentSecurityPolicy,
      "cache-control": "no-cache",
    },
  });
}

export function createFrontHandler({
  nitroUrl,
  staticRoot = null,
}: {
  nitroUrl: string;
  /** The verified editor bundle, served at `/artcraft/` from its read-only directory. */
  staticRoot?: string | null;
}) {
  const contentSecurityPolicy =
    staticRoot === null ? null : editorContentSecurityPolicy(staticRoot);

  const records: ProxyRecord[] = [];
  const trace: ProxyRecord[] = [];
  const faults: Fault[] = [];
  const transport: TransportEvent[] = [];
  let inFlightTileMedia = 0;
  let peakInFlightTileMedia = 0;

  async function toNitro(request: Request, url: URL) {
    const headers = new Headers(request.headers);

    for (const name of HOP_HEADERS) headers.delete(name);
    // The public Host stays, as the host adapter requires of its gateway.
    headers.set("host", url.host);
    headers.set("accept-encoding", "identity");

    const response = await fetch(new URL(`${url.pathname}${url.search}`, nitroUrl), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: request.signal,
      redirect: "manual",
    });

    const outgoing = new Headers(response.headers);

    for (const name of [...HOP_HEADERS, "content-encoding"]) outgoing.delete(name);

    return new Response(response.body, { status: response.status, headers: outgoing });
  }

  function countBody(
    response: Response,
    record: ProxyRecord,
    signal: AbortSignal,
    onEnd: () => void,
  ) {
    const startedAt = record.at;
    let ended = false;

    const finish = (outcome: ProxyRecord["outcome"]) => {
      if (ended) return;
      ended = true;
      record.outcome = outcome;
      record.durationMs = Date.now() - startedAt;
      onEnd();
    };

    if (signal.aborted) finish("aborted");
    else signal.addEventListener("abort", () => finish("aborted"), { once: true });

    if (response.body === null) {
      finish("complete");

      return response;
    }

    const counted = response.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          record.bytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
        flush: () => finish("complete"),
      }),
    );

    return new Response(counted, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  async function handle(request: Request, protocol: ProxyRecord["protocol"]): Promise<Response> {
    const url = new URL(request.url);

    if (
      staticRoot !== null &&
      contentSecurityPolicy !== null &&
      url.pathname.startsWith(STATIC_PREFIX)
    ) {
      const reply = staticResponse(staticRoot, contentSecurityPolicy, url.pathname);

      trace.push({
        at: Date.now(),
        protocol,
        method: request.method,
        path: `${url.pathname}${url.search}`,
        operation: null,
        rpcBody: null,
        range: null,
        status: reply.status,
        bytes: 0,
        contentRange: null,
        contentLength: reply.headers.get("content-length"),
        contentType: reply.headers.get("content-type"),
        cacheControl: reply.headers.get("cache-control"),
        durationMs: 0,
        outcome: "complete",
        failure: null,
        errorBody: null,
      });

      return reply;
    }

    let forwarded = request;
    let operation: string | null = null;
    let rpcBody: string | null = null;

    // Only RPC envelopes are read here. File bytes stream through untouched.
    if (url.pathname === "/api/rpc" && request.method === "POST") {
      const body = await request.text();

      operation = rpcOperation(body);
      rpcBody = body;
      forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body,
        signal: request.signal,
      });
    }

    const record: ProxyRecord = {
      at: Date.now(),
      protocol,
      method: request.method,
      path: `${url.pathname}${url.search}`,
      operation,
      rpcBody,
      range: request.headers.get("range"),
      status: 0,
      bytes: 0,
      contentRange: null,
      contentLength: null,
      contentType: null,
      cacheControl: null,
      durationMs: 0,
      outcome: "pending",
      failure: null,
      errorBody: null,
    };

    records.push(record);
    trace.push(record);

    const fault = faults.find((candidate) => candidate.remaining > 0 && candidate.matches(record));

    if (fault !== undefined) fault.remaining -= 1;

    if (fault?.action.kind === "refuse") {
      record.status = fault.action.status;
      record.outcome = "complete";

      return Response.json(
        { ok: false, error: { code: "service.unavailable", message: "Fixture refused this." } },
        { status: fault.action.status },
      );
    }

    if (fault?.action.kind === "hold") {
      await Promise.race([
        fault.action.released,
        new Promise((resolve) => {
          request.signal.addEventListener("abort", resolve, { once: true });
        }),
      ]);

      if (request.signal.aborted) {
        record.outcome = "aborted";

        return new Response(null, { status: 499 });
      }
    }

    if (fault?.action.kind === "stall-body" && request.body !== null) {
      const reader = request.body.getReader();
      const { released } = fault.action;

      forwarded = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
        body: new ReadableStream<Uint8Array>({
          async start(controller) {
            const first = await reader.read();

            if (first.value !== undefined) controller.enqueue(first.value);
            await released;
            controller.error(new Error("Fixture stalled this upload."));
          },
        }),
        // @ts-expect-error Fetch requires this for a streamed body; lib.dom omits it from RequestInit.
        duplex: "half",
      });
    }

    const isTileMedia =
      url.pathname.startsWith("/api/storage/previews/") ||
      url.pathname.startsWith("/api/storage/derivatives/");

    if (isTileMedia) {
      inFlightTileMedia += 1;
      peakInFlightTileMedia = Math.max(peakInFlightTileMedia, inFlightTileMedia);
    }

    const leave = () => {
      if (isTileMedia) inFlightTileMedia -= 1;
    };

    // A real disconnect while the backend is working: its request goes up, then its connection goes
    // away. What the backend does then is the point, so nothing here decides the outcome.
    if (fault?.action.kind === "abandon-request") {
      const upstream = new AbortController();
      const { afterMs, replyStarted } = fault.action;

      void toNitro(new Request(forwarded, { signal: upstream.signal }), url).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, afterMs));
      upstream.abort();
      leave();
      record.outcome = "abandoned";

      return new Response(
        new ReadableStream<Uint8Array>({
          // With no reply yet, Chromium may silently resend the request on a reused connection.
          // Once a reply has begun it can't, so the failure reaches the page.
          async start(controller) {
            if (replyStarted) {
              controller.enqueue(new TextEncoder().encode('{"ok":tr'));
              await new Promise((resolve) => setTimeout(resolve, 50));
            }

            controller.error(new Error("Fixture abandoned this request."));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    let response: Response;

    try {
      response = await toNitro(forwarded, url);
    } catch (error) {
      leave();
      record.outcome = "aborted";
      record.failure = `${String(error)}; browser gone: ${request.signal.aborted}`;
      throw error;
    }

    record.status = response.status;

    if (response.status >= 400 && operation !== null) {
      record.errorBody = await response.clone().text();
    }

    record.contentRange = response.headers.get("content-range");
    record.contentLength = response.headers.get("content-length");
    record.contentType = response.headers.get("content-type");
    record.cacheControl = response.headers.get("cache-control");

    // The backend has fully acted by now; only what the browser hears about it changes.
    if (fault?.action.kind === "replace-reply") {
      await response.body?.cancel();
      leave();
      record.status = fault.action.status;
      record.outcome = "dropped";

      return Response.json(
        { ok: false, error: { code: "service.unavailable", message: "Fixture lost this reply." } },
        { status: fault.action.status },
      );
    }

    // For states a real backend can't be made to reach on demand. Never evidence of how they arise.
    if (fault?.action.kind === "rewrite-reply") {
      const body = fault.action.transform(await response.text());
      const headers = new Headers(response.headers);

      headers.delete("content-length");
      leave();
      record.bytes = body.length;
      record.outcome = "complete";

      return new Response(body, { status: response.status, headers });
    }

    // A connection that dies partway through the reply: headers arrive, then the body breaks off.
    if (fault?.action.kind === "drop-reply") {
      await response.body?.cancel();
      leave();
      record.outcome = "dropped";

      return new Response(
        new ReadableStream<Uint8Array>({
          async start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":tr'));
            await new Promise((resolve) => setTimeout(resolve, 50));
            controller.error(new Error("Fixture dropped this connection."));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }

    return countBody(response, record, request.signal, leave);
  }

  return {
    handle,
    records,
    trace,
    peakInFlightTileMedia: () => peakInFlightTileMedia,
    transport,
    noteTransport(kind: string, detail: string) {
      transport.push({ at: Date.now(), kind, detail });
    },
    resetCounters() {
      records.length = 0;
      inFlightTileMedia = 0;
      peakInFlightTileMedia = 0;
    },
    hold(matches: Fault["matches"], count = 1) {
      let release = () => {};

      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      faults.push({ matches, action: { kind: "hold", released }, remaining: count });

      return release;
    },
    replaceReply(matches: Fault["matches"], status = 503) {
      faults.push({ matches, action: { kind: "replace-reply", status }, remaining: 1 });
    },
    abandonRequest(matches: Fault["matches"], afterMs: number, replyStarted: boolean) {
      faults.push({
        matches,
        action: { kind: "abandon-request", afterMs, replyStarted },
        remaining: 1,
      });
    },
    dropReply(matches: Fault["matches"]) {
      faults.push({ matches, action: { kind: "drop-reply" }, remaining: 1 });
    },
    rewriteReplies(matches: Fault["matches"], transform: (body: string) => string) {
      faults.push({
        matches,
        action: { kind: "rewrite-reply", transform },
        remaining: Number.POSITIVE_INFINITY,
      });
    },
    stallBody(matches: Fault["matches"]) {
      let release = () => {};

      const released = new Promise<void>((resolve) => {
        release = resolve;
      });

      faults.push({ matches, action: { kind: "stall-body", released }, remaining: 1 });

      return release;
    },
    refuse(matches: Fault["matches"], status = 503, count = 1) {
      faults.push({ matches, action: { kind: "refuse", status }, remaining: count });
    },
    clearFaults() {
      faults.length = 0;
    },
  };
}

export type FrontHandler = ReturnType<typeof createFrontHandler>;

type Tls = { readonly key: string; readonly cert: string };

export function serveHttp1(handler: FrontHandler, port: number, tls: Tls) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port,
    tls,
    idleTimeout: 120,
    fetch: (request) => handler.handle(request, "http/1.1"),
  });

  return () => void server.stop(true);
}

/** Waits for room to write, leaving no listeners behind for a long download's next chunk. */
function writable(stream: http2.ServerHttp2Stream) {
  return new Promise<void>((resolve) => {
    const done = () => {
      stream.off("drain", done);
      stream.off("close", done);
      resolve();
    };

    stream.once("drain", done);
    stream.once("close", done);
  });
}

/** A request body read at the pace the backend takes it, so uploads stay streamed. */
function requestBody(stream: http2.ServerHttp2Stream) {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      stream.on("data", (chunk: Buffer) => {
        controller.enqueue(new Uint8Array(chunk));

        if ((controller.desiredSize ?? 0) <= 0) stream.pause();
      });
      stream.once("end", () => controller.close());
      stream.once("error", (error) => controller.error(error));
    },
    pull() {
      stream.resume();
    },
    cancel() {
      stream.destroy();
    },
  });
}

/** The same handler over real HTTP/2, which Bun.serve doesn't offer here. */
export function serveHttp2(handler: FrontHandler, port: number, origin: string, tls: Tls) {
  const server = http2.createSecureServer({ ...tls, allowHTTP1: false });
  let sessions = 0;

  server.on("session", (session: http2.ServerHttp2Session) => {
    sessions += 1;

    const id = sessions;

    handler.noteTransport("session-open", String(id));
    session.on("goaway", (code: number, lastStream: number) =>
      handler.noteTransport("session-goaway", `${id}: code ${code}, last stream ${lastStream}`),
    );
    session.on("error", (error: Error) =>
      handler.noteTransport("session-error", `${id}: ${String(error)}`),
    );
    session.on("close", () => handler.noteTransport("session-close", String(id)));
  });

  server.on("stream", (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => {
    const method = String(headers[":method"]);
    const route = `${method} ${String(headers[":path"])}`;
    const abort = new AbortController();

    stream.once("close", () => {
      if (stream.rstCode !== 0) {
        handler.noteTransport("stream-reset", `${route}: code ${stream.rstCode}`);
      }

      abort.abort();
    });
    stream.on("error", (error: Error) => {
      handler.noteTransport("stream-error", `${route}: ${String(error)}`);
      abort.abort();
    });

    const forwarded = new Headers();

    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(":") || value === undefined) continue;
      forwarded.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }

    forwarded.set("host", new URL(origin).host);

    const hasBody = method !== "GET" && method !== "HEAD";

    const init: RequestInit & { duplex?: "half" } = {
      method,
      headers: forwarded,
      signal: abort.signal,
    };

    if (hasBody) {
      init.body = requestBody(stream);
      init.duplex = "half";
    }

    const request = new Request(new URL(String(headers[":path"]), origin), init);

    void handler
      .handle(request, "h2")
      .then(async (response) => {
        const outgoing: http2.OutgoingHttpHeaders = { ":status": response.status };

        response.headers.forEach((value, name) => {
          if (name !== "set-cookie") outgoing[name] = value;
        });

        const cookies = response.headers.getSetCookie();

        if (cookies.length > 0) outgoing["set-cookie"] = cookies;
        stream.respond(outgoing);

        const reader = response.body?.getReader();

        while (reader !== undefined) {
          const { done, value } = await reader.read();

          if (done) break;

          if (stream.destroyed) {
            await reader?.cancel();
            break;
          }

          if (!stream.write(value)) await writable(stream);
        }

        stream.end();
      })
      .catch((error: Error) => {
        handler.noteTransport("reply-failed", `${route}: ${String(error)}`);
        stream.destroy();
      });
  });

  server.listen(port, "127.0.0.1");

  return () => void server.close();
}
