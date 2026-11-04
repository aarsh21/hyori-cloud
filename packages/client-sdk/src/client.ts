import { operations } from "@hyori-cloud/api/rpc";
import { deriveOperations } from "#client-sdk/operation-catalog";
import type { InputOf } from "#client-sdk/inference";
import type { RPC } from "#client-sdk/product-types";
import { createTransport } from "#client-sdk/transport";
import type { TransportOptions } from "#client-sdk/transport";
import { createUploads } from "#client-sdk/features/uploads/upload";
import { SDKError } from "#client-sdk/errors";

export type ClientOptions = TransportOptions & {
  /** Non-secret identity/tenant cache partition; never supply a password or token. */
  readonly cacheScope?: string;
};

export function createClient(options: ClientOptions = {}) {
  const transport = createTransport(options);
  const catalog = deriveOperations(operations, transport.invoke, options.cacheScope ?? "session");
  const uploads = createUploads(catalog.rpc.uploads, transport.request);

  return {
    ...catalog,
    uploads,
    downloads: {
      /** Stream bytes to a host-owned sink; this helper never buffers an entire file. */
      open: async (
        input: InputOf<RPC["files"]["download"]>,
        options?: { signal?: AbortSignal },
      ) => {
        const metadata = await catalog.rpc.files.download(input, options);
        const response = await transport.request(metadata.url, { signal: options?.signal });

        if (!response.ok)
          throw new SDKError("SDK_TRANSPORT", `Download failed (${response.status}).`);

        if (!response.body)
          throw new SDKError("SDK_PROTOCOL", "The download has no readable body.");

        return { metadata, stream: response.body };
      },
    },
    dispose: () => {
      uploads.dispose();
      transport.dispose();
    },
  };
}

export type Client = ReturnType<typeof createClient>;
