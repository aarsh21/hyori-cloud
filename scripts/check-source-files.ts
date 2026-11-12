import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const result = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
  encoding: "utf8",
});

if (result.status !== 0) throw new Error("Cannot inspect repository source files.");

// This exact Bun-generated executable is frozen test evidence, not authored JavaScript.
// Deployment's provenance regression verifies its executed hash/receipt and TypeScript source.
function isGeneratedClockDriver(file: string) {
  return (
    file === "tooling/artcraft/capabilities-v1/native-clock-probe/driver.js" &&
    readFileSync(file, "utf8").startsWith("// @bun\n// scripts/artcraft/native-clock-driver.ts\n")
  );
}

const violations = result.stdout
  .split("\0")
  .filter(
    (file) =>
      file !== "" &&
      existsSync(file) &&
      /\.(?:js|jsx|mjs|cjs)$/.test(file) &&
      !file.startsWith("tooling/fernando-lint/") &&
      !isGeneratedClockDriver(file),
  );

if (violations.length !== 0) {
  console.error(
    "Authored JavaScript/MJS is not allowed; use TypeScript. Generated/ignored output and the explicitly vendored checker are outside this gate.",
  );
  console.error(violations.join("\n"));
  process.exitCode = 1;
} else {
  console.log(
    "TypeScript-only authored source gate passed; generated output and vendored third-party code are unchanged.",
  );
}
