import { operations } from "@hyori-cloud/api/wire";
import { deriveOperations } from "#client-sdk/operation-catalog";
import type { InputOf } from "#client-sdk/inference";
import type { RPC } from "#client-sdk/product-types";
import { createTransport } from "#client-sdk/transport";
import type { TransportOptions } from "#client-sdk/transport";
import { createUploads } from "#client-sdk/features/uploads/upload";
import { createEditors } from "#client-sdk/features/editors/create-editors";
import { SDKError } from "#client-sdk/errors";
import { readBinaryRejection } from "#client-sdk/read-binary-rejection";

export type ClientOptions = TransportOptions & {
  /** Non-secret identity/tenant cache partition; never supply a password or token. */
  readonly cacheScope?: string;
};

export function createClient(options: ClientOptions = {}) {
  const transport = createTransport(options);
  const catalog = deriveOperations(operations, transport.invoke, options.cacheScope ?? "session");
  const uploads = createUploads(catalog.rpc.uploads, transport.request);
  const editors = createEditors(catalog.rpc.editors, uploads, transport.request);

  return {
    ...catalog,
    uploads,
    editors,
    downloads: {
      /** Stream bytes to a host-owned sink; this helper never buffers an entire file. */
      open: async (
        input: InputOf<RPC["files"]["download"]>,
        options?: { signal?: AbortSignal },
      ) => {
        const metadata = await catalog.rpc.files.download(input, options);
        const response = await transport.request(metadata.url, { signal: options?.signal });

        if (!response.ok) throw await readBinaryRejection(response, options?.signal);

        if (!response.body)
          throw new SDKError("SDK_PROTOCOL", "The download has no readable body.");
        const length = response.headers.get("content-length");

        if (
          length !== null &&
          (!/^(0|[1-9]\d*)$/.test(length) || Number(length) !== metadata.size)
        ) {
          await response.body.cancel().catch(() => undefined);
          throw new SDKError("SDK_PROTOCOL", "Download length does not match its descriptor.");
        }

        return { metadata, stream: response.body };
      },
    },
    previews: {
      /**
       * Inline bytes at a URL `files.preview` handed out, through the transport the session
       * already owns. Range headers are the caller's bound on what streams in.
       */
      fetch: (url: string, options?: { headers?: Record<string, string>; signal?: AbortSignal }) =>
        transport.request(url, { headers: options?.headers, signal: options?.signal }),
    },
    dispose: () => {
      editors.dispose();
      uploads.dispose();
      transport.dispose();
    },
  };
}

export type Client = ReturnType<typeof createClient>;
