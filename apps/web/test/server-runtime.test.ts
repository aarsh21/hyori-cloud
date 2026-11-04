import { expect, test } from "bun:test";
import { getAppRuntime } from "@/app/runtime";
import { getRouter } from "@/router";

test("actual server router requests own separate SDKs and Query caches", () => {
  expect(globalThis.window).toBeUndefined();
  const first = getRouter();
  const second = getRouter();
  const a = first.options.context;
  const b = second.options.context;

  try {
    expect(a).not.toBe(b);
    expect(a.queryClient).not.toBe(b.queryClient);
    expect(a.sdkClient).not.toBe(b.sdkClient);
    const key = a.sdkClient.query.auth.status.getOptions({}).queryKey;

    a.queryClient.setQueryData(key, { initialized: true, user: null });
    expect(a.queryClient.getQueryState(key)?.data).toEqual({ initialized: true, user: null });
    expect(b.queryClient.getQueryData(key)).toBeUndefined();
    const third = getAppRuntime();

    expect(third).not.toBe(a);
    expect(third.queryClient.getQueryData(key)).toBeUndefined();
    third.sdkClient.dispose();
    third.queryClient.clear();
  } finally {
    a.sdkClient.dispose();
    b.sdkClient.dispose();
    a.queryClient.clear();
    b.queryClient.clear();
  }
});
