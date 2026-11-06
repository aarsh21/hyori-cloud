# syntax=docker/dockerfile:1.7
FROM rust:1.99.1-slim-trixie@sha256:59f72d5265cfcf281fcfa4d990e75f09c53f911def9913c47a4a89dca690a887 AS builder
RUN apt-get update \
    && apt-get install -y --no-install-recommends libicu-dev libssl-dev pkg-config clang \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY Cargo.toml Cargo.lock rust-toolchain.toml ./
COPY apps/server ./apps/server
COPY apps/media-worker ./apps/media-worker
COPY crates/storage ./crates/storage
# The server compiles these editor authorities in with include_str!.
COPY tooling/artcraft/manifest.json tooling/artcraft/runtime-deckcraft-v2.json tooling/artcraft/runtime-native-v3*.json ./tooling/artcraft/
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/app/target \
    icu_version="$(pkg-config --modversion icu-uc)" \
    && CARGO_BUILD_JOBS=2 RUST_ICU_MAJOR_VERSION_NUMBER="${icu_version%%.*}" cargo build --release --locked --bin hyori-server \
    && cp target/release/hyori-server /usr/local/bin/hyori-server

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
