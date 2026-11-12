# Colour-tagged still-image regression fixtures

These are locally synthesized 800×600 RGB test inputs, dedicated to CC0-1.0. They contain no user or third-party imagery. Created on 2026-11-12; they are protocol/decoder fixtures, not product artwork.

All start with the same asymmetric stepped gradient: R = floor(x × 31 / 800) × 8, G = floor(y × 23 / 600) × 11, B = 80. PNG scanlines use filter 0, RGB8, zlib compression, and standard CRC32 chunks. Only the following chunks differ between the six PNG files; all IDAT bytes are identical:

| File           | Chunk after IHDR | Payload                                                           |
| -------------- | ---------------- | ----------------------------------------------------------------- |
| `plain.png`    | None             | IHDR, IDAT, IEND only                                             |
| `srgb.png`     | sRGB             | Rendering intent 0                                                |
| `gamma.png`    | gAMA             | 45455, big endian                                                 |
| `chroma.png`   | cHRM             | 31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000, big endian |
| `cicp.png`     | cICP             | 1, 13, 0, 1 (BT.709/sRGB/identity/full range)                     |
| `combined.png` | sRGB, gAMA, cHRM | Same payloads, in that order                                      |

Other formats were encoded from `srgb.png` by the worker runtime's pinned Debian FFmpeg `7:7.1.5-0+deb13u1`, using one frame and one encoder thread:

- `icc.webp`: `-c:v libwebp`, then a WebP extended header (ICCP flag, width−1 = 799, height−1 = 599) and ICCP chunk inserted before the unmodified VP8 chunk. RIFF/chunk lengths and padding adjusted.
- `icc.gif`: `-c:v gif`, then an `ICCRGBG1012` application extension immediately after the global colour table, with the ICC bytes split into ≤255-byte sub-blocks and a zero terminator. GIF has palette colour, not PNG-style transfer/primaries fields. FFmpeg 7 ignores this ICC extension; the fixture proves it accepts such an input, not that it colour-manages it.
- `icc.jpg`: `-c:v mjpeg`, then one JPEG APP2 segment after SOI: `ICC_PROFILE\0`, sequence 1, count 1, ICC bytes.
- `srgb.avif`: `-c:v libaom-av1 -cpu-used 8 -pix_fmt yuv420p -color_primaries bt709 -color_trc iec61966-2-1 -colorspace bt709`; its `colr/nclx` and AV1 colour fields identify BT.709/sRGB.

The embedded ICC profile is an sRGB monitor profile synthesized with LittleCMS 2 (`cmsCreate_sRGBProfile` → `cmsSaveProfileToFile` → `cmsCloseProfile`), not a downloaded vendor profile. FFprobe in the pinned runtime reports ICC frame side data for JPEG and WebP, and colour primaries/transfer on the tagged PNG and AVIF inputs. No input metadata should be copied to the thumbnail.

`isolated_worker_derives_colour_tagged_stills_without_output_metadata` sends every fixture to the real network-disabled, nonroot, read-only, 1-CPU/512-MiB worker. It requires HTTP 200, the strict metadata-free WebP envelope, exact 244×183 geometry matching response headers, and a successful independent FFmpeg decode. The PNG-output worker from `e3225e8` fails all five tagged PNG cases with 422 while the plain control succeeds. This protects against reintroducing the reported colour-property/output-validator mismatch; it is not a general colour-fidelity test.
