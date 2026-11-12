FROM rclone/rclone@sha256:3103526c506266a9ecdf064efe99bf3677d92ef6407af124d8c56b4f49cbaa51 AS rclone
FROM oven/bun:1.4.4@sha256:1d22548f177f4ff38e0c15baa3c2c46c6c2060ba2d1bc573bb4720b407548f1d AS builder
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile && bun build scripts/ops-backup.ts scripts/ops-backup-scheduler.ts --target=bun --outdir=/out

FROM postgres:17@sha256:ff87138949ad9a46f32ff23bd6852b52ce024a13dffe9b4087be98292cdd3b4f
COPY --from=builder /usr/local/bin/bun /usr/local/bin/bun
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY --from=builder /out /app
ENTRYPOINT ["bun", "/app/ops-backup-scheduler.js"]
