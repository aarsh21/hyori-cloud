# Synthetic video decoder fixtures

Generated locally with `bun scripts/generate-media-video-fixtures.ts` using FFmpeg's `color`, `drawbox`, `sine`, `format` and `crop` sources. They contain no user media, external footage, fonts, embedded photographs or private metadata. The generator and these generated fixture bytes are dedicated to the public domain under CC0-1.0. They are test inputs, not product artwork.

Each clip is two seconds at four frames per second. The four quadrants are red, lime, blue and yellow, in reading order, so rotation can be tested independently of the thumbnail implementation. `rotated.mp4` is the video-only H.264 fixture remuxed with a +90-degree display matrix, not physically rotated pixels. FFmpeg autorotation should produce portrait output with lime/yellow/red/blue quadrants. `odd.mp4` has exactly 1919 × 1079 coded pixels in 4:4:4; the other high-resolution cases are 1080 × 2340 and 3840 × 2160.

The cases include leading/trailing moov atoms, fragmented MP4 with AAC and Opus, video-only and audio-first streams, yuv444, odd/tall/4K geometry, H.264 QuickTime, HEVC, AV1, VP9 MP4/WebM and display-matrix rotation. Codec support is verified through the real isolated worker, not inferred from filenames. The FFmpeg implementation itself retains its upstream/packaging license; see the worker README for redistribution requirements.
