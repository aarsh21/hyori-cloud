import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

// Bundle authored code and its public dependency boundary; do not execute any vendor WASM.
test("new native bridge browser entry consumes canonical public codecs without a second wire-schema owner", async () => {
  const protocol = await readFile(
    "tooling/artcraft/patches/native-host-v3/host-protocol.ts",
    "utf8",
  );

  expect(protocol).toContain('from "@hyori-cloud/client-sdk/editor-runtime"');
  expect(protocol).not.toMatch(/from ["']zod["']|z\.object|Schema\.Struct/);

  const result = await Bun.build({
    entrypoints: ["tooling/artcraft/patches/native-host-v3/host-entry.ts"],
    target: "browser",
    format: "esm",
    minify: true,
  });

  expect(result.logs).toEqual([]);
  expect(result.success).toBe(true);
  expect(result.outputs.length).toBe(1);
  const code = await result.outputs[0]!.text();
  expect(code).toContain("prepareHost");
  expect(code).toContain("hostSerialized");
  expect(code).toContain("hostAcknowledged");
  expect(code).toContain("hostTakeCancellation");
  expect(code).toContain("hostTakeFailure");
  expect(code).toContain("hostThemeApplied");
  expect(code).not.toContain("KeyboardEvent");
  expect(code).not.toContain(".focus()");
});
