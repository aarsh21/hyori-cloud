import { Schema } from "@hyori-cloud/lib/effect";
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

const envelopeValue = Schema.Unknown.pipe(Schema.filter((value) => value !== undefined));

const decodeEnvelope = Schema.decodeUnknownSync(
  Schema.Union(
    Schema.Struct({ ok: Schema.Literal(true), value: envelopeValue }),
    Schema.Struct({ ok: Schema.Literal(false), error: envelopeValue }),
  ),
);

export function encodeOperationInput<D extends OperationDeclaration>(
  declaration: D,
  input: Payload<D>,
) {
  try {
    return Schema.encodeUnknownSync(
      Schema.make<Payload<D>, Schema.Schema.Encoded<D["rpc"]["payloadSchema"]>>(
        declaration.rpc.payloadSchema.ast,
      ),
    )(input);
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
    const signal = init.signal ? AbortSignal.any([init.signal, lifetime.signal]) : lifetime.signal;

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
      });

      const envelope = await response
        .json()
        .then(decodeEnvelope)
        .catch((cause) => {
          if (requestOptions?.signal?.aborted || lifetime.signal.aborted)
            throw new SDKError("SDK_CANCELLED", "The operation was cancelled.", { cause });
          throw new SDKError(
            "SDK_PROTOCOL",
            `The server returned an invalid RPC envelope (${response.status}).`,
            { cause },
          );
        });

      if (!envelope.ok) {
        const declaredError = Schema.decodeUnknownSync(
          Schema.make<
            Schema.Schema.Type<D["rpc"]["errorSchema"]>,
            Schema.Schema.Encoded<D["rpc"]["errorSchema"]>
          >(declaration.rpc.errorSchema.ast),
        );

        const failure = (() => {
          try {
            return declaredError(envelope.error);
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
        return Schema.decodeUnknownSync(
          Schema.make<Success<D>, Schema.Schema.Encoded<D["rpc"]["successSchema"]>>(
            declaration.rpc.successSchema.ast,
          ),
        )(envelope.value);
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
