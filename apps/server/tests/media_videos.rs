#[expect(
    dead_code,
    reason = "This suite only starts and independently decodes with the shared fixture"
)]
#[path = "support/media_worker.rs"]
mod media_worker;
use hyori_media_worker::webp_dimensions;

#[tokio::test]
#[ignore = "real isolated FFmpeg worker: generated video shapes and display-matrix rotation"]
async fn isolated_worker_decodes_video_shapes_and_applies_display_matrix() {
    let worker = media_worker::Worker::start().await;
    let client = worker.client();
    let directory = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../media-worker/tests/fixtures/video");
    for (name, mime, dimensions) in [
        ("faststart.mp4", "video/mp4", (244, 137)),
        ("trailing-moov.mp4", "video/mp4", (244, 137)),
        ("fragmented-aac.mp4", "video/mp4", (244, 137)),
        ("fragmented-opus.mp4", "video/mp4", (244, 137)),
        ("video-only.mp4", "video/mp4", (244, 137)),
        ("audio-first.mp4", "video/mp4", (244, 137)),
        ("yuv444.mp4", "video/mp4", (244, 137)),
        ("odd.mp4", "video/mp4", (244, 137)),
        ("tall.mp4", "video/mp4", (113, 244)),
        ("4k.mp4", "video/mp4", (244, 137)),
        ("h264.mov", "video/quicktime", (244, 137)),
        ("hevc.mp4", "video/mp4", (244, 137)),
        ("av1.mp4", "video/mp4", (244, 137)),
        ("vp9.mp4", "video/mp4", (244, 137)),
        ("vp9.webm", "video/webm", (244, 137)),
        ("rotated.mp4", "video/mp4", (137, 244)),
    ] {
        let source = std::fs::read(directory.join(name)).unwrap();
        let response = client
            .post("http://localhost/v1/derive")
            .header("x-hyori-media-type", mime)
            .body(source)
            .send()
            .await
            .unwrap();
        let status = response.status();
        let bytes = response.bytes().await.unwrap();
        assert_eq!(status, 200, "{name}: {}", String::from_utf8_lossy(&bytes));
        assert_eq!(webp_dimensions(&bytes), Some(dimensions), "{name}");
        worker.decode_output(&bytes);
        println!(
            "{name}: {status}, {dimensions:?}, {} decoded bytes",
            bytes.len()
        );

        if name == "rotated.mp4" {
            let path = worker.socket.parent().unwrap().join("orientation.webp");
            std::fs::write(&path, &bytes).unwrap();
            let output = std::process::Command::new("docker")
                .args([
                    "exec",
                    &worker.name,
                    "/usr/bin/ffmpeg",
                    "-v",
                    "error",
                    "-threads",
                    "1",
                    "-i",
                    "/run/hyori-media/orientation.webp",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "pipe:1",
                ])
                .output()
                .unwrap();
            assert!(output.status.success());
            let (w, h) = dimensions;
            // +90-degree display matrix is a counterclockwise display transform: the source's
            // top-right lime quadrant must land at the displayed top-left, not just swap dimensions.
            for ((x, y), expected) in [
                ((w / 4, h / 4), [0_i16, 255, 0]),
                ((3 * w / 4, h / 4), [255, 255, 0]),
                ((w / 4, 3 * h / 4), [255, 0, 0]),
                ((3 * w / 4, 3 * h / 4), [0, 0, 255]),
            ] {
                let offset = ((y * w + x) * 3) as usize;
                let actual = &output.stdout[offset..offset + 3];
                assert!(
                    actual
                        .iter()
                        .zip(expected)
                        .all(|(a, b)| (i16::from(*a) - b).abs() < 25),
                    "rotated pixel {x},{y}: {actual:?}"
                );
            }
            std::fs::remove_file(path).unwrap();
        }
    }
}
