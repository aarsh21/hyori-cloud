import { expect, test } from "bun:test";
import { ClientError, normalizeClientError, SDKError } from "@hyori-cloud/client-sdk";
import { Schema } from "@hyori-cloud/lib/effect";

test("the public client error boundary preserves declared failures and SDK instances", () => {
  const declared = { code: "service.unavailable", message: "Offline" } satisfies ClientError;
  const local = new SDKError("SDK_CANCELLED", "Paused");
  expect(normalizeClientError(declared)).toEqual(declared);
  expect(normalizeClientError(local)).toBe(local);
  expect(Schema.is(ClientError)(local)).toBe(true);
});

test("unexpected host failures are normalized rather than entering UI as an unchecked error", () => {
  const failure = normalizeClientError(new Error("Browser download failed"));
  expect(failure).toBeInstanceOf(SDKError);
  expect(failure.code).toBe("SDK_TRANSPORT");
  expect(normalizeClientError({ code: "invented", message: "Invalid" }).code).toBe("SDK_TRANSPORT");
});
