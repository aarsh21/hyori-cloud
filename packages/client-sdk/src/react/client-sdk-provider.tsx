"use client";

import { createContext, use } from "@hyori-cloud/lib/react";
import type { ReactNode } from "@hyori-cloud/lib/react";
import type { Client } from "#client-sdk/client";

const ClientSDKContext = createContext<Client | null>(null);

export function ClientSDKProvider({
  sdkClient,
  children,
}: {
  readonly sdkClient: Client;
  readonly children: ReactNode;
}) {
  return <ClientSDKContext value={sdkClient}>{children}</ClientSDKContext>;
}

export function useClientSDK(): Client {
  const sdkClient = use(ClientSDKContext);

  if (!sdkClient) throw new Error("useClientSDK requires a ClientSDKProvider.");

  return sdkClient;
}

export function useQueryApi() {
  return useClientSDK().query;
}
