import { createClient, SDKError, type InputOf, type OutputOf } from "@hyori-cloud/client-sdk";

let requests = 0;

const sdkClient = createClient({
  baseUrl: "https://artifact.invalid/api/rpc",
  fetch: async (url, init) => {
    if (String(url) !== "https://artifact.invalid/api/rpc" || init?.method !== "POST")
      throw new Error("The packed client did not use its configured transport.");

    if (String(init.body) !== JSON.stringify({ operation: "auth.status", input: {} }))
      throw new Error("The packed client did not derive the expected operation.");
    requests += 1;

    return Response.json({ ok: true, value: { initialized: true, user: null } });
  },
});

export function consumeInferredTypes(
  input: InputOf<typeof sdkClient.query.files.list>,
  output: OutputOf<typeof sdkClient.rpc.files.list>,
) {
  const name: string | undefined = output.items[0]?.name;

  // @ts-expect-error A packed consumer must retain operation input checking.
  sdkClient.query.files.list.getOptions({ parentId: 123 });
  // @ts-expect-error A packed consumer must retain result inference, not any.
  const invalid: number = output.items[0]!.name;

  return { name, invalid, options: sdkClient.query.files.list.getOptions(input) };
}

const status = await sdkClient.rpc.auth.status({});

const queryStatus = await sdkClient.query.auth.status
  .getOptions({})
  .queryFn({ signal: new AbortController().signal });

if (!status.initialized || status.user !== null || !queryStatus.initialized || requests !== 2)
  throw new Error("The packed vanilla client did not decode its real operation response.");

sdkClient.dispose();

try {
  await sdkClient.rpc.auth.status({});
  throw new Error("The packed SDK ignored disposal.");
} catch (error) {
  if (!(error instanceof SDKError) || error.code !== "SDK_DISPOSED") throw error;
}

console.log(
  "PASS packed vanilla runtime, codecs, derived query, inference, and disposal (fake Fetch)",
);
