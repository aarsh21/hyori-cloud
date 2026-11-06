import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export const MEDIA_FORMATS = [
  { extension: "png", mimeType: "image/png" },
  { extension: "jpg", mimeType: "image/jpeg" },
  { extension: "webp", mimeType: "image/webp" },
  { extension: "gif", mimeType: "image/gif" },
  { extension: "avif", mimeType: "image/avif" },
  { extension: "mp4", mimeType: "video/mp4" },
  { extension: "webm", mimeType: "video/webm" },
  { extension: "mov", mimeType: "video/quicktime" },
] as const;

export function sha256(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Everything here is synthetic: random bytes, the repo's CC0 fixtures, or local FFmpeg test patterns. */
export function createMediaKit(directory: string) {
  mkdirSync(directory, { recursive: true });

  const ffmpeg = (...args: string[]) =>
    execFileSync("ffmpeg", ["-v", "error", "-y", ...args], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: 120_000,
    });

  return {
    directory,
    /** Random bytes under the given name. */
    bytes(name: string, size: number) {
      const path = join(directory, name);

      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(size));

      return path;
    },
    /** The repo's CC0 16x16 fixture, copied under a run-specific name. */
    fixture(extension: string, name = `red.${extension}`) {
      const path = join(directory, name);

      copyFileSync(
        join(process.cwd(), "apps/server/tests/fixtures/media", `red.${extension}`),
        path,
      );

      return path;
    },
    /** A numbered test pattern, so a wrong image shows on screen. Noise keeps it from compressing. */
    png(name: string, label: number, size = "960x720") {
      const path = join(directory, name);

      ffmpeg(
        "-f",
        "lavfi",
        "-i",
        `testsrc2=s=${size}:d=1:r=1,drawtext=text='${label}':fontsize=160:fontcolor=white:x=40:y=40,noise=alls=40:allf=t`,
        "-frames:v",
        "1",
        path,
      );

      return path;
    },
    /** A longer clip than the fixtures, so seeking has somewhere to go. */
    video(name: string, seconds: number, codecArgs: readonly string[]) {
      const path = join(directory, name);

      ffmpeg("-f", "lavfi", "-i", `testsrc2=s=320x240:d=${seconds}:r=24`, ...codecArgs, path);

      return path;
    },
  };
}

export type MediaKit = ReturnType<typeof createMediaKit>;
