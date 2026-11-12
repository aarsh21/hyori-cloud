import { execFileSync } from "node:child_process";
import { z } from "zod";

const majorVersion = z.string().regex(/^\d+$/);

export function rustBuildConfig() {
  const icuVersion =
    process.env.RUST_ICU_MAJOR_VERSION_NUMBER ??
    execFileSync("pkg-config", ["--modversion", "icu-uc"], { encoding: "utf8" })
      .trim()
      .split(".")[0];

  return {
    executable: process.env.CARGO ?? "cargo",
    env: { ...process.env, RUST_ICU_MAJOR_VERSION_NUMBER: majorVersion.parse(icuVersion) },
  };
}
