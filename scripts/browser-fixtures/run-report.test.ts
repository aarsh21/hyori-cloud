import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "playwright-core";
import { createRunReport } from "./run-report.ts";

for (const captureFailures of [false, true]) {
  test(`global failure-capture policy ${captureFailures} cannot be overridden by a check`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "hyori-report-policy-"));
    let screenshots = 0;

    // SAFETY: The reporter consumes only these Page methods; this fake never captures a browser image.
    const page = {
      isClosed: () => false,
      on() {},
      async screenshot() {
        screenshots += 1;

        return Buffer.alloc(0);
      },
    } as Page;

    try {
      const report = createRunReport(directory, { captureFailures });
      report.watch(page);
      expect(
        await report.check(
          "synthetic failure",
          () => {
            throw new Error("Expected test failure");
          },
          { captureFailure: true },
        ),
      ).toBe(false);
      await report.scenario(
        "synthetic scenario",
        async () => {
          throw new Error("Expected scenario failure");
        },
        { captureFailure: true },
      );
      expect(screenshots).toBe(captureFailures ? 2 : 0);
      await report.shot(page, "explicit-permitted-document");
      expect(screenshots).toBe(captureFailures ? 3 : 1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
