import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const SUITE_TIMEOUT_MS = 180_000;

// Real components need a DOM from before React DOM loads, while the rest of this test process must
// stay a non-browser host. See `test/dom-environment.ts`.
test(
  "mounted component regressions pass in their own DOM process",
  async () => {
    const suites = Bun.spawn(
      [
        process.execPath,
        "test",
        "--preload",
        "./packages/features/test/dom-environment.ts",
        "--preload",
        "./packages/features/test/mounted.tsx",
        "./packages/features/test",
      ],
      { cwd: REPOSITORY_ROOT, stdout: "inherit", stderr: "inherit" },
    );

    expect(await suites.exited).toBe(0);
  },
  SUITE_TIMEOUT_MS,
);
