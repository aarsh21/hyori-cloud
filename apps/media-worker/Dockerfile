# syntax=docker/dockerfile:1.7
FROM rust:1.99.1-slim-trixie@sha256:59f72d5265cfcf281fcfa4d990e75f09c53f911def9913c47a4a89dca690a887 AS builder
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY crates/storage ./crates/storage
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    CARGO_BUILD_JOBS=2 cargo build --release --locked -p hyori-media-worker \
    && cp target/release/hyori-media-worker /usr/local/bin/hyori-media-worker

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS runtime
ARG FFMPEG_PACKAGE_VERSION=7:7.1.5-0+deb13u1
RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg="${FFMPEG_PACKAGE_VERSION}" \
    && mkdir -p /usr/share/hyori-media \
    && dpkg-query -W > /usr/share/hyori-media/packages.txt \
    && ffmpeg -version > /usr/share/hyori-media/ffmpeg-version.txt \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 hyori-media \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hyori-media
COPY --from=builder /usr/local/bin/hyori-media-worker /usr/local/bin/hyori-media-worker
USER 10001:10001
ENV HYORI_MEDIA_SOCKET=/run/hyori-media/worker.sock
ENTRYPOINT ["/usr/local/bin/hyori-media-worker"]
