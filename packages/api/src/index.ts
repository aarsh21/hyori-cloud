import { Schema } from "@hyori-cloud/lib/effect";
import { attachmentDisposition } from "#api/attachment-disposition";
import { WriteConflict } from "@hyori-cloud/lib/surreal";
import { ApiError, operations } from "@hyori-cloud/core/rpc";
import {
  CHUNK_SIZE,
  createBindings,
  DomainError,
  FilesService,
  Maintenance,
  RequestContext,
  Runtime,
  type ServerConfig,
  UploadsService,
} from "@hyori-cloud/core/server";

export type { ServerConfig } from "@hyori-cloud/core/server";

export type { Api } from "@hyori-cloud/core/rpc";

export type Handler = ((request: Request) => Promise<Response>) & {
  maintenance: () => Promise<{ uploads: number; accounts: number }>;
  dispose: () => void;
};

type Operation = (typeof operations)[number];

type OperationInput = Schema.Schema.Type<Operation["rpc"]["payloadSchema"]>;

type OperationResult = Schema.Schema.Type<Operation["rpc"]["successSchema"]>;

type RpcResponse = { ok: true; value: OperationResult } | { ok: false; error: ApiError };

const Envelope = Schema.Struct({
  operation: Schema.String.pipe(Schema.maxLength(100)),
  input: Schema.Unknown,
});

async function readBounded(request: Request, maximum: number): Promise<Uint8Array> {
  const statedLength = request.headers.get("content-length");

  if (statedLength && Number(statedLength) > maximum)
    throw new DomainError("input.invalid", "Request body is too large");

  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const result = await reader.read();

      if (result.done) break;
      size += result.value.byteLength;

      if (size > maximum) {
        await reader.cancel();
        throw new DomainError("input.invalid", "Request body is too large");
      }

      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

function statusFor(code: ApiError["code"]): number {
  switch (code) {
    case "auth.required":
    case "auth.invalidCredentials":
      return 401;
    case "auth.setupDenied":
    case "access.denied":
      return 403;
    case "auth.rateLimited":
      return 429;
    case "resource.notFound":
      return 404;
    case "resource.conflict":
    case "storage.quotaExceeded":
      return 409;
    case "input.invalid":
      return 400;
    case "service.unavailable":
      return 503;
  }
}

function json(body: RpcResponse, status: number, headers = new Headers()): Response {
  headers.set("Content-Type", "application/json");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Content-Type-Options", "nosniff");

  return new Response(JSON.stringify(body), { status, headers });
}

/** Generic JSON adapter over the composed Effect RPC schemas; not Effect's NDJSON protocol. */
export function createHandler(
  config: ServerConfig & { onError?: (error: Error) => void },
): Handler {
  const runtime = new Runtime(config);
  const maintenance = new Maintenance(runtime);

  const catalog = new Map<string, Operation>(
    operations.map((operation) => [operation.rpc._tag, operation]),
  );

  const handle = async (request: Request): Promise<Response> => {
    const context = new RequestContext(runtime, request);

    try {
      const url = new URL(request.url);

      if (url.origin !== runtime.config.origin)
        throw new DomainError("access.denied", "Unexpected request origin");
      const suppliedOrigin = request.headers.get("origin");
      const fetchSite = request.headers.get("sec-fetch-site");

      if (
        (suppliedOrigin && suppliedOrigin !== runtime.config.origin) ||
        fetchSite === "cross-site"
      )
        throw new DomainError("access.denied", "Cross-origin access is not allowed");

      if (
        request.method !== "GET" &&
        request.headers.has("cookie") &&
        !suppliedOrigin &&
        !["same-origin", "none"].includes(fetchSite ?? "")
      )
        throw new DomainError(
          "access.denied",
          "Cookie-authenticated writes require the configured Origin",
        );

      if (url.pathname === runtime.config.basePath) {
        if (request.method !== "POST")
          return json(
            { ok: false, error: { code: "input.invalid", message: "Use POST for RPC" } },
            405,
          );

        if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json"))
          throw new DomainError("input.invalid", "RPC requests must use application/json");
        let envelope: typeof Envelope.Type;

        try {
          envelope = Schema.decodeUnknownSync(Envelope)(
            JSON.parse(new TextDecoder().decode(await readBounded(request, 256 * 1024))),
          );
        } catch (error) {
          if (error instanceof DomainError) throw error;
          throw new DomainError("input.invalid", "Invalid RPC request");
        }

        const operation = catalog.get(envelope.operation);

        if (!operation) throw new DomainError("resource.notFound", "Unknown operation");
        let input: OperationInput;

        try {
          input = Schema.decodeUnknownSync(Schema.asSchema(operation.rpc.payloadSchema))(
            envelope.input,
          );
        } catch {
          throw new DomainError("input.invalid", "The operation input is invalid");
        }

        await runtime.initialize();
        const bindings = createBindings(context);

        // SAFETY: input was decoded with this exact operation's payload schema. The statically
        // checked binding map uses the same tag; this local assertion restores that indexed
        // correlation, which TypeScript loses for a runtime-selected union of handler functions.
        const invoke = bindings[operation.rpc._tag] as (
          value: OperationInput,
        ) => Promise<OperationResult>;

        const result = await invoke(input);

        const value = Schema.encodeSync(Schema.asSchema(operation.rpc.successSchema))(
          Schema.decodeUnknownSync(Schema.asSchema(operation.rpc.successSchema))(result),
        );

        return json({ ok: true, value }, 200, context.responseHeaders);
      }

      if (url.pathname.startsWith(`${runtime.config.storagePath}/`)) {
        await runtime.initialize();
        const path = url.pathname.slice(runtime.config.storagePath.length).split("/");

        if (path[1] === "uploads" && path.length === 4 && request.method === "PUT") {
          const uploadId = path[2]!;
          const partNumber = Number(path[3]);

          if (!/^[a-f0-9]{32}$/.test(uploadId))
            throw new DomainError("input.invalid", "Invalid upload ID");

          const value = await new UploadsService(context).writePart(
            uploadId,
            partNumber,
            await readBounded(request, CHUNK_SIZE),
          );

          return json({ ok: true, value }, 200, context.responseHeaders);
        }

        if (path[1] === "files" && path.length === 3 && request.method === "GET") {
          const fileId = path[2]!;

          if (!/^[a-f0-9]{32}$/.test(fileId))
            throw new DomainError("input.invalid", "Invalid file ID");

          const result = await new FilesService(context).readBinary(
            fileId,
            url.searchParams.get("version"),
            request.headers.get("range") ?? undefined,
          );

          const headers = context.responseHeaders;
          // Attachments cannot execute attacker-controlled HTML/SVG in the application's origin.
          headers.set("Content-Type", result.mimeType);
          headers.set("Content-Disposition", attachmentDisposition(result.name));
          headers.set("Content-Length", String(result.size));
          headers.set("Accept-Ranges", "bytes");
          headers.set("Cache-Control", "private, no-store");
          headers.set("X-Content-Type-Options", "nosniff");
          headers.set("Content-Security-Policy", "sandbox; default-src 'none'");

          if (result.contentRange) headers.set("Content-Range", result.contentRange);

          return new Response(result.body, { status: result.contentRange ? 206 : 200, headers });
        }
      }

      throw new DomainError("resource.notFound", "Endpoint not found");
    } catch (error) {
      if (!(error instanceof DomainError)) {
        const diagnostic =
          error instanceof Error
            ? error
            : new Error("Unexpected backend failure", { cause: error });

        config.onError?.(diagnostic);
      }

      const failure: ApiError =
        error instanceof DomainError
          ? { code: error.code, message: error.message }
          : error instanceof WriteConflict
            ? {
                code: "resource.conflict",
                message: "A concurrent operation changed this resource; retry",
              }
            : { code: "service.unavailable", message: "The service is unavailable; retry shortly" };

      return json(
        { ok: false, error: Schema.encodeSync(ApiError)(failure) },
        statusFor(failure.code),
      );
    }
  };

  return Object.assign(handle, {
    maintenance: () => maintenance.run(),
    dispose: () => runtime.storage.close(),
  });
}
