# syntax=docker/dockerfile:1
# Requires BuildKit for RUN --mount=type=cache.

# Shell base: bun + a shell, used by every build-time stage.
# Both oven/bun pins in this file must match root package.json's
# `packageManager` — CI installs Bun from that field, so a skew runs the tests on
# a different runtime than the one that ships. Dependabot's docker ecosystem only
# bumps these lines, so ci.yml's "Bun version skew" step guards the pairing.
FROM oven/bun:1.3.14 AS base
WORKDIR /app

# turbo isolated here so it never reaches the runner; the version is derived
# from the root package.json devDependency so a Dependabot turbo bump can
# never drift from the image.
FROM base AS toolchain
COPY package.json ./
RUN bun add -g turbo@"$(bun --print 'require("./package.json").devDependencies.turbo')"

# 1) Prune the monorepo to the subset @gaggiuino/server needs.
#    Produces /app/out/json (package.json files), /app/out/full (sources),
#    and /app/out/bun.lock (subset lockfile).
FROM toolchain AS pruner
COPY . .
RUN turbo prune @gaggiuino/server --docker

# 2) Build: full deps then turbo build of the server's dependencies, which
#    runs the shot-graph vite build (packages/shot-graph/dist/app.html).
#    The server itself is JIT, hence the `^...` filter.
FROM toolchain AS builder
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile
COPY --from=pruner /app/out/full/ ./
RUN turbo run build --filter=@gaggiuino/server^...

# 3) Prod-only deps, prepared in a SHELL stage.
#    Distroless cannot RUN, so the install and chown happen here.
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --production
RUN chown -R 65534:65534 /app

# 4) Distroless runner: COPY only. nonroot (65534), no shell, ENTRYPOINT is bun.
FROM oven/bun:1.3.14-distroless AS runner
WORKDIR /app

# MCP registry ownership proof: publish-mcp.yml publishes server.json listing
# this image as its OCI package, and the registry pulls the image to check this
# label matches the server name. Must stay in sync with `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.ljcl/gaggiuino-mcp"
COPY --from=prod-deps --chown=65534:65534 /app ./
COPY --from=builder  --chown=65534:65534 /app/apps/server/src ./apps/server/src
COPY --from=builder  --chown=65534:65534 /app/apps/server/scripts ./apps/server/scripts
COPY --from=builder  --chown=65534:65534 /app/packages/shot-graph/dist ./packages/shot-graph/dist

USER 65534:65534
ENV NODE_ENV=production
EXPOSE 8000

# Exec-form healthcheck: no shell, no wget. Full bun path because HEALTHCHECK
# does not route through ENTRYPOINT.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/bun","--eval","fetch('http://localhost:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# ENTRYPOINT is already /usr/local/bin/bun, so CMD omits the leading "bun".
CMD ["run","apps/server/src/index.ts"]
