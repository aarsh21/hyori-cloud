# syntax=docker/dockerfile:1.7
FROM rust:1.99.1-slim-trixie@sha256:59f72d5265cfcf281fcfa4d990e75f09c53f911def9913c47a4a89dca690a887 AS chef
# cargo-chef builds the locked dependency graph in its own layer, so a source change reuses it.
RUN cargo install cargo-chef --locked --version 0.1.78 && rm -rf /usr/local/cargo/registry
WORKDIR /app

FROM chef AS planner
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY crates/storage ./crates/storage
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS cook
ARG CARGO_BUILD_JOBS=2
COPY rust-toolchain.toml ./
COPY --from=planner /app/recipe.json recipe.json
RUN CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS}" cargo chef cook --release --locked --recipe-path recipe.json -p hyori-media-worker

FROM cook AS builder
ARG CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY crates/storage ./crates/storage
# Dropping target keeps this per-commit layer small in the build cache.
RUN CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS}" cargo build --release --locked -p hyori-media-worker \
    && cp target/release/hyori-media-worker /usr/local/bin/hyori-media-worker \
    && rm -rf target

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
