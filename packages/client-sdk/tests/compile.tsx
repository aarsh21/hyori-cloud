import { createClient } from "@hyori-cloud/client-sdk";
import type { InputOf, OutputOf, FileEntry, UploadSnapshot } from "@hyori-cloud/client-sdk";
import {
  ClientSDKProvider,
  createQuery,
  setMutationDefaults,
  useClientSDK,
} from "@hyori-cloud/client-sdk/react";
import type { ResourceOf, SuspenseResourceOf } from "@hyori-cloud/client-sdk/react";
import { QueryClient, useMutation, useQuery, useSuspenseQuery } from "@hyori-cloud/lib/query";

const sdkClient = createClient({
  baseUrl: "https://example.invalid/api/rpc",
  cacheScope: "account-1",
});

const queryClient = new QueryClient();

setMutationDefaults(queryClient);

const query = createQuery(sdkClient);

queryClient.prefetchQuery(query.files.list.getOptions({ parentId: null }));

queryClient.setQueryData(query.files.list.getKey({}), {
  items: [],
  folder: null,
  breadcrumbs: [],
  nextCursor: null,
});

// @ts-expect-error Cache writes retain the declared output type.
queryClient.setQueryData(query.files.list.getKey({}), { incorrect: true });

// @ts-expect-error Query/mutation namespaces are filtered by authoritative kind.
void query.files.createFolder;

// @ts-expect-error Mutations cannot be projected as query resources.
export type InvalidResource = ResourceOf<typeof sdkClient.mutation.files.createFolder>;

// @ts-expect-error Arbitrary values are not valid operation type helpers.
export type InvalidInput = InputOf<number>;

// @ts-expect-error Input remains runtime-schema derived.
query.files.list.getOptions({ limit: "one" });

export type ListingInput = InputOf<typeof query.files.list>;

export type SameInput = InputOf<typeof query.files.list.getOptions>;

export type Listing = OutputOf<typeof query.files.list>;

export type SameListing = OutputOf<typeof query.files.list.getOptions>;

export type Created = OutputOf<typeof sdkClient.rpc.files.createFolder>;

export type AuthInput = InputOf<typeof query.auth.status.getOptions>;

export const emptyInput: AuthInput = {};

// Function callability constraints must preserve payloads even when a function returns null or void.
export const functionInput: InputOf<(input: { id: string }) => null> = { id: "example" };

export const functionOutput: OutputOf<(input: { id: string }) => Promise<null>> = null;

// @ts-expect-error Ordinary function input extraction must not become an unconstrained payload.
export const invalidFunctionInput: InputOf<(input: { id: string }) => void> = { id: 42 };

// @ts-expect-error Output inference keeps the actual return type, not the callability constraint.
export const invalidFunctionOutput: OutputOf<(input: { id: string }) => Promise<null>> = 42;

// @ts-expect-error A failed upload must carry an actual normalized error.
export const invalidFailure: Extract<UploadSnapshot, { status: "failed" }>["error"] = null;

// @ts-expect-error A completed upload requires the committed file.
export const invalidCompletion: Extract<UploadSnapshot, { status: "complete" }>["file"] = null;

export function useListing(input: ListingInput): ResourceOf<typeof query.files.list> {
  const client = useClientSDK();

  return useQuery(client.query.files.list.getOptions(input));
}

export function useSuspenseListing(
  input: ListingInput,
): SuspenseResourceOf<typeof query.files.list.getOptions> {
  return useSuspenseQuery(useClientSDK().query.files.list.getOptions(input));
}

export function useCreateFolder() {
  return useMutation(useClientSDK().mutation.files.createFolder.mutationOptions());
}

sdkClient.mutation.files.createFolder.setDefaults(queryClient, {
  onMutate(input) {
    return { oldName: input.name };
  },
  onError(_error, _input, context) {
    const original: string | undefined = context?.oldName;
    void original;
  },
  onSuccess(file, input) {
    const typedFile: FileEntry = file;
    const typedName: string = input.name;
    void typedFile;
    void typedName;
  },
});

sdkClient.mutation.files.createFolder.setDefaults(queryClient, {
  // @ts-expect-error mutation callbacks infer the actual operation result.
  onSuccess(file: number) {
    void file;
  },
});

export function Fixture() {
  return (
    <ClientSDKProvider sdkClient={sdkClient}>
      <FixtureConsumer />
    </ClientSDKProvider>
  );
}

function FixtureConsumer() {
  const result = useListing({});

  if (result.status === "success") {
    const entries: readonly FileEntry[] = result.data.items;
    void entries;
  }

  return null;
}
