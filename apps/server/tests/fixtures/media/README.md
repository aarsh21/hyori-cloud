# Synthetic protocol fixtures

The eight `red.*` fixtures contain only a locally synthesized 16×16 red square (one frame for images, 0.2 seconds for videos), with no user content or third-party imagery. Created with the installed FFmpeg `n9.0.2`, on 2026-11-05. They are test inputs, not product artwork or generated thumbnails. No external service received media. The original fixture content is dedicated to the public domain under CC0-1.0; FFmpeg's software license does not license its output.

Reproduction: `ffmpeg -f lavfi -i color=c=red:s=16x16:d=0.2 ... red.EXT`.

- PNG/JPEG/WebP/GIF: `-frames:v 1` and the extension's default encoder.
- AVIF: `-frames:v 1 -c:v libaom-av1 -cpu-used 8`.
- MP4/MOV: `-c:v libx264 -pix_fmt yuv420p`.
- WebM: `-c:v libvpx-vp9`.

Additional derivative-worker fixtures, synthesized locally on 2026-11-05 with the same CC0 dedication:

- `oriented.jpg`: a 32×16 red rectangle from FFmpeg `n9.0.2`, with a manually encoded JPEG APP1 Exif/TIFF orientation tag (0x0112, SHORT, value 6). The isolated worker must output portrait geometry and no EXIF chunk. No camera data or third-party photograph is included.
- `over-duration.mp4`: `ffmpeg -f lavfi -i color=c=red:s=16x16:r=1:d=121 -c:v libx264 -pix_fmt yuv420p over-duration.mp4`. Its 121-second synthetic duration exceeds the 120-second worker budget.
- `over-pixels.png`: a valid 7000×6000, RGB8 uniform red PNG, constructed with standard-library Python `struct`/`zlib` and CRC32 chunks. Compression was streamed one 21,001-byte scanline at a time, not decoded from user input. Its 42 million pixels exceed the 40-million-pixel worker budget while the source is only 137,098 bytes.

The real isolated-worker tests additionally decode all eight supported formats to normalized PNG and reject these resource-limit cases. That checks the exercised decoder path and orientation case, not general format/browser/visual fidelity.

The original HTTP/SDK tests exercise signature-family rejection, declared MIME matching, byte identity, ranges, authorization, and response headers. Header validation is not full decoding or a proof of browser codec/fidelity support. These files can additionally be decoded locally with `ffmpeg -v error -i FILE -f null -`.
