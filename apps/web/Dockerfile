FROM node:24 AS builder
COPY --from=oven/bun:1.4.4 /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
# .dockerignore excludes all actual environment files and existing deployment data.
COPY . .
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
ENV NODE_ENV=production
RUN bun run --filter web build
# Varlock auto-load resolves only the shipped schema and runtime process environment.
# Its CLI is bundled JavaScript with no required package dependencies.
RUN mkdir -p /runtime/node_modules/.bin && cp -RL node_modules/varlock /runtime/node_modules/varlock && cp -RL apps/web/node_modules/react /runtime/node_modules/react && ln -s ../varlock/bin/cli.js /runtime/node_modules/.bin/varlock

FROM node:24-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3001
# Nitro output is standalone. Do not ship workspace tooling, legacy services or env files.
COPY --from=builder --chown=node:node /app/apps/web/.output /app/.output
COPY --from=builder --chown=node:node /runtime/node_modules /app/node_modules
COPY --from=builder --chown=node:node /app/apps/web/.env.schema /app/.env.schema
USER node
EXPOSE 3001
CMD ["node", ".output/server/index.mjs"]
