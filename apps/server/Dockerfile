FROM oven/bun:1.3.6 AS base
WORKDIR /app
RUN bun add -g turbo@2

# 1) Prune the monorepo to the subset @gaggiuino/server needs.
#    Produces /app/out/json (package.json files only), /app/out/full (sources),
#    and /app/out/bun.lock (subset lockfile).
FROM base AS pruner
COPY . .
RUN turbo prune @gaggiuino/server --docker

# 2) Build: install full deps (dev + prod) then run turbo build.
#    Because server depends on gaggiuino-shot-graph, turbo ^build runs
#    shot-graph's vite build first, producing packages/shot-graph/dist/app.html.
FROM base AS builder
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
RUN turbo run build --filter=@gaggiuino/server

# 3) Runner: lean image with prod-only deps plus built shot-graph dist.
#    Prod install links workspace deps by symlink; we fill in the built
#    dist/ from the builder stage so createRequire(...).resolve("…/app.html")
#    works at runtime.
FROM base AS runner
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun install --frozen-lockfile --production
COPY --from=builder /app/apps/server/src ./apps/server/src
COPY --from=builder /app/packages/shot-graph/dist ./packages/shot-graph/dist

ENV NODE_ENV=production
EXPOSE 8000
CMD ["bun", "run", "apps/server/src/index.ts"]
