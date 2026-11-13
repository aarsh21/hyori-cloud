import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

// Synthetic codec/container inputs, not product artwork. Source and CC0 dedication live beside them.
const directory = join(import.meta.dirname, "../apps/media-worker/tests/fixtures/video");

mkdirSync(directory, { recursive: true });

function ffmpeg(args: string[]) {
  execFileSync("ffmpeg", ["-y", "-v", "error", "-threads", "1", ...args], {
    stdio: ["ignore", "inherit", "inherit"],
  });
}

function clip(name: string, size: string, codec: string[], options: string[] = [], audio = false) {
  const source = ["-f", "lavfi", "-i", `color=red:s=${size}:r=4:d=2`];
  const sound = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=2"];
  ffmpeg([
    ...source,
    ...(audio ? sound : []),
    "-vf",
    "drawbox=x=iw/2:y=0:w=iw/2:h=ih/2:c=lime:t=fill,drawbox=x=0:y=ih/2:w=iw/2:h=ih/2:c=blue:t=fill,drawbox=x=iw/2:y=ih/2:w=iw/2:h=ih/2:c=yellow:t=fill",
    ...codec,
    "-threads",
    "1",
    "-filter_threads",
    "1",
    ...options,
    join(directory, name),
  ]);
}

const h264 = ["-c:v", "libx264", "-preset", "ultrafast", "-crf", "30", "-pix_fmt", "yuv420p"];

clip("faststart.mp4", "320x180", h264, ["-movflags", "+faststart"]);

clip("trailing-moov.mp4", "320x180", h264);

clip(
  "fragmented-aac.mp4",
  "320x180",
  h264,
  ["-c:a", "aac", "-movflags", "+frag_keyframe+empty_moov"],
  true,
);

clip(
  "fragmented-opus.mp4",
  "320x180",
  h264,
  ["-c:a", "libopus", "-movflags", "+frag_keyframe+empty_moov"],
  true,
);

clip("video-only.mp4", "320x180", h264);

clip("audio-first.mp4", "320x180", h264, ["-map", "1:a:0", "-map", "0:v:0", "-c:a", "aac"], true);

clip("yuv444.mp4", "320x180", [...h264, "-pix_fmt", "yuv444p"]);

// lavfi's default 4:2:0 source rounds odd sizes down; use a 4:4:4 source before encoding.
ffmpeg([
  "-f",
  "lavfi",
  "-i",
  "color=red:s=1920x1080:r=4:d=2,format=yuv444p,crop=1919:1079",
  ...h264,
  "-pix_fmt",
  "yuv444p",
  "-threads",
  "1",
  join(directory, "odd.mp4"),
]);

clip("tall.mp4", "1080x2340", h264);

clip("4k.mp4", "3840x2160", h264);

clip("h264.mov", "320x180", h264);

clip(
  "hevc.mp4",
  "320x180",
  [
    "-c:v",
    "libx265",
    "-preset",
    "ultrafast",
    "-x265-params",
    "pools=1:frame-threads=1:log-level=error",
    "-pix_fmt",
    "yuv420p",
  ],
  ["-tag:v", "hvc1"],
);

clip("av1.mp4", "320x180", [
  "-c:v",
  "libaom-av1",
  "-cpu-used",
  "8",
  "-crf",
  "45",
  "-pix_fmt",
  "yuv420p",
]);

const vp9 = [
  "-c:v",
  "libvpx-vp9",
  "-deadline",
  "realtime",
  "-cpu-used",
  "8",
  "-crf",
  "40",
  "-b:v",
  "0",
  "-pix_fmt",
  "yuv420p",
];

clip("vp9.mp4", "320x180", vp9);

clip("vp9.webm", "320x180", vp9);

ffmpeg([
  "-display_rotation",
  "90",
  "-i",
  join(directory, "video-only.mp4"),
  "-c",
  "copy",
  join(directory, "rotated.mp4"),
]);
