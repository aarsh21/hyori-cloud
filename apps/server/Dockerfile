# syntax=docker/dockerfile:1.7
FROM rust:1.99.1-slim-trixie@sha256:59f72d5265cfcf281fcfa4d990e75f09c53f911def9913c47a4a89dca690a887 AS chef
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu-dev libssl-dev pkg-config clang \
    && rm -rf /var/lib/apt/lists/*
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
RUN icu_version="$(pkg-config --modversion icu-uc)" \
    && CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS}" RUST_ICU_MAJOR_VERSION_NUMBER="${icu_version%%.*}" cargo chef cook --release --locked --recipe-path recipe.json --bin hyori-server

FROM cook AS builder
ARG CARGO_BUILD_JOBS=2
COPY Cargo.toml Cargo.lock ./
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY crates/storage ./crates/storage
# The server compiles these editor authorities in with include_str!.
COPY tooling/artcraft/manifest.json tooling/artcraft/runtime-deckcraft-v2.json tooling/artcraft/runtime-native-v3*.json ./tooling/artcraft/
# Dropping target keeps this per-commit layer small in the build cache.
RUN icu_version="$(pkg-config --modversion icu-uc)" \
    && CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS}" RUST_ICU_MAJOR_VERSION_NUMBER="${icu_version%%.*}" cargo build --release --locked --bin hyori-server \
    && cp target/release/hyori-server /usr/local/bin/hyori-server \
    && rm -rf target

FROM debian:trixie-slim@sha256:f6b08b09a05725f9431502d3b5714f5c4576e82c1a84fa1debe0c24a7e0c3ec4 AS runtime
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libssl3t64 libicu76 libzstd1 libbrotli1 zlib1g \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 hyori \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin hyori
COPY --from=builder /usr/local/bin/hyori-server /usr/local/bin/hyori-server
USER 10001:10001
ENV APP_ENV=production HYORI_SERVER_BIND=0.0.0.0:3002
EXPOSE 3002
ENTRYPOINT ["/usr/local/bin/hyori-server"]
