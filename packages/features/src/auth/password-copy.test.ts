import { describe, expect, test } from "bun:test";
import { SDKError } from "@hyori-cloud/client-sdk";
import { describeChangePasswordError, newPasswordProblem } from "#features/auth/password-copy.ts";

describe("password copy", () => {
  // The server counts Unicode scalar values; UTF-16 length would let 6 emoji pass as 12.
  test("counts characters as the server does", () => {
    expect(newPasswordProblem("🔑".repeat(11))).not.toBeNull();
    expect(newPasswordProblem("🔑".repeat(12))).toBeNull();
    expect(newPasswordProblem("a".repeat(11))).not.toBeNull();
  });

  test("a lost reply never says the password is unchanged", () => {
    for (const code of ["SDK_TRANSPORT", "SDK_PROTOCOL"] as const) {
      const copy = describeChangePasswordError(new SDKError(code, "lost"));

      expect(`${copy.title} ${copy.detail}`).toContain("may already be the new one");
    }
  });
});
