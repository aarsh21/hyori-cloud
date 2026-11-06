import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { readAcquisitionFile } from "./content-delivery.ts";
import { digest, relativePath } from "./content-schema.ts";
import { sha256 } from "./evidence-bytes.ts";

const root = "tooling/artcraft/capabilities-v1/native-clock-probe";
const receiptPin = "a45e9f5ccc61cfe4affdc97d33c761b2f2fb14745441f1d082e587a5885d3a43";

test("generated driver preserves exact executed bytes and frozen restricted-clock receipt", async () => {
  const receiptBytes = await readAcquisitionFile(root, "receipt.json");
  expect(sha256(receiptBytes)).toBe(receiptPin);

  const receipt = z
    .object({
      testsPassed: z.literal(5),
      testsFailed: z.literal(0),
      exactCurrentClockSource: z.literal(true),
      fullEngineBuild: z.literal(false),
      files: z
        .array(
          z.object({
            path: relativePath,
            bytes: z
              .number()
              .int()
              .nonnegative()
              .max(4 * 1024 * 1024),
            sha256: digest,
          }),
        )
        .max(100),
    })
    .parse(JSON.parse(receiptBytes.toString()));

  for (const file of receipt.files) {
    const bytes = await readAcquisitionFile(root, file.path);
    expect(bytes.length).toBe(file.bytes);
    expect(sha256(bytes)).toBe(file.sha256);
  }

  const plan = z
    .object({ driverSha256: digest })
    .parse(JSON.parse((await readAcquisitionFile(root, "probe-inputs.json")).toString()));

  const driver = await readAcquisitionFile(root, "driver.js");
  expect(sha256(driver)).toBe(plan.driverSha256);
  expect(driver.toString()).toStartWith("// @bun\n// scripts/artcraft/native-clock-driver.ts\n");
  expect(sha256(await readFile("scripts/artcraft/native-clock-driver.ts"))).toBe(
    "55d434dc8290140ea32e73c1c0c42a9e4585a0c6113558cc850bbb2028a8efcf",
  );
  expect(
    (await readAcquisitionFile(root, "src-clock.rs")).equals(
      await readFile("tooling/artcraft/patches/native-host-v3/native-clock.rs"),
    ),
  ).toBe(true);
});
