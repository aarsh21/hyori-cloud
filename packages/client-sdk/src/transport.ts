import * as z from "@hyori-cloud/lib/json";
import type { OperationDeclaration, Payload, Success } from "#client-sdk/inference";
import { normalizeError, SDKError } from "#client-sdk/errors";
import type { RequestOptions } from "#client-sdk/operation-catalog";

export type FetchCapability = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export type TransportOptions = {
  readonly baseUrl?: string;
  readonly fetch?: FetchCapability;
  readonly credentials?: RequestCredentials;
};

const envelopeValue = z.unknown().check(z.refine((value) => value !== undefined));

const rpcEnvelope = z.union([
  z.object({ ok: z.literal(true), value: envelopeValue }),
  z.object({ ok: z.literal(false), error: envelopeValue }),
]);

export function encodeOperationInput<D extends OperationDeclaration>(
  declaration: D,
  input: Payload<D>,
) {
  try {
    return declaration.rpc.payloadSchema.parse(input);
  } catch (cause) {
    throw new SDKError("SDK_VALIDATION", "The operation input is invalid.", { cause });
  }
}

export function createTransport(options: TransportOptions) {
  const baseUrl = options.baseUrl ?? "/api/rpc";
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
  const credentials = options.credentials ?? "same-origin";
  const absoluteBase = /^[a-z][a-z0-9+.-]*:/i.test(baseUrl) ? new URL(baseUrl) : null;
  const resolveUrl = (url: string) => (absoluteBase ? new URL(url, absoluteBase).href : url);
  const lifetime = new AbortController();

  const request = async (url: string, init: RequestInit = {}) => {
    if (lifetime.signal.aborted)
      throw new SDKError("SDK_DISPOSED", "This SDK client has been disposed.");
    const scope = init.keepalive ? AbortSignal.timeout(10_000) : lifetime.signal;
    const signal = init.signal ? AbortSignal.any([init.signal, scope]) : scope;

    try {
      signal.throwIfAborted();
      const response = await fetcher(resolveUrl(url), { ...init, credentials, signal });
      signal.throwIfAborted();

      return response;
    } catch (cause) {
      if (signal.aborted)
        throw new SDKError("SDK_CANCELLED", "The operation was cancelled.", { cause });
      throw normalizeError(cause);
    }
  };

  return {
    request,
    dispose: () => lifetime.abort(),
    async invoke<D extends OperationDeclaration>(
      declaration: D,
      input: Payload<D>,
      requestOptions?: RequestOptions,
    ): Promise<Success<D>> {
      const encodedInput = encodeOperationInput(declaration, input);

      const response = await request(baseUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operation: declaration.rpc._tag, input: encodedInput }),
        signal: requestOptions?.signal,
        keepalive: requestOptions?.keepalive,
      });

      const body = await response.text().catch((cause) => {
        if (
          requestOptions?.signal?.aborted ||
          (!requestOptions?.keepalive && lifetime.signal.aborted)
        )
          throw new SDKError("SDK_CANCELLED", "The operation was cancelled.", { cause });
        // A broken stream can also throw AbortError; only the caller's signal means cancellation.
        throw new SDKError("SDK_TRANSPORT", "The RPC response was interrupted.", { cause });
      });

      const envelope = (() => {
        try {
          return rpcEnvelope.parse(JSON.parse(body));
        } catch (cause) {
          // Gateways cannot emit our envelope when their upstream is unavailable.
          if ([502, 503, 504].includes(response.status))
            throw { code: "service.unavailable", message: "Service temporarily unavailable" };
          throw new SDKError(
            "SDK_PROTOCOL",
            `The server returned an invalid RPC envelope (${response.status}).`,
            { cause },
          );
        }
      })();

      if (!envelope.ok) {
        const failure = (() => {
          try {
            return declaration.rpc.errorSchema.parse(envelope.error);
          } catch (cause) {
            throw new SDKError("SDK_PROTOCOL", "The server returned an undeclared failure.", {
              cause,
            });
          }
        })();

        throw failure;
      }

      if (!response.ok)
        throw new SDKError("SDK_TRANSPORT", `The request failed (${response.status}).`);

      try {
        // SAFETY: the declaration's Rust-derived codec is the source of Success<D>.
        return declaration.rpc.successSchema.parse(envelope.value) as Success<D>;
      } catch (cause) {
        throw new SDKError(
          "SDK_PROTOCOL",
          "The operation result did not match its declared schema.",
          { cause },
        );
      }
    },
  };
}
