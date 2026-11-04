FROM node:24 AS builder
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
ENV NODE_ENV=production
RUN bun run --filter web build

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
COPY --from=builder /app /app
EXPOSE 3001
WORKDIR /app/apps/web
CMD ["node", ".output/server/index.mjs"]
