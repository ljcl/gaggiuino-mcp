# syntax=docker/dockerfile:1
# Requires BuildKit for RUN --mount=type=cache.

# Shell base: bun + a shell, used by every build-time stage.
# Both oven/bun pins in this file must match root package.json's
# `packageManager` — CI installs Bun from that field, so a skew runs the tests on
# a different runtime than the one that ships. Dependabot's docker ecosystem only
# bumps these lines, so ci.yml's "Bun version skew" step guards the pairing.
FROM oven/bun:1.4.2 AS base
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
#    Distroless cannot RUN, so the install happens here.
#
#    Only the server's own runtime closure is installed. The pruned workspace
#    still lists shot-graph, ui, design-system and vite-config, and a plain
#    `--production` install brings in every one of their `dependencies` —
#    React, recharts, the v1 MCP SDK, Vite, esbuild — none of which the server
#    loads: it reaches shot-graph only to resolve the prebuilt dist/app.html.
#    That was ~180 packages where the server needs four, and every scanner
#    run against the image flagged CVEs in code that never executes.
#
#    So the workspace packages' dependency fields are emptied here (in this
#    stage only; the repo's manifests are untouched), `--lockfile-only`
#    re-resolves the lockfile against the existing pins without running
#    anything, and the production install then sees only the server's deps.
#    The workspace link to @gaggiuino/shot-graph survives, which is what the
#    runtime `require.resolve("@gaggiuino/shot-graph/app.html")` needs.
FROM base AS prod-deps
COPY --from=pruner /app/out/json/ ./
COPY --from=pruner /app/out/bun.lock ./bun.lock
RUN bun --eval ' \
      const fs = require("node:fs"); \
      for (const dir of fs.readdirSync("packages")) { \
        const file = `packages/${dir}/package.json`; \
        if (!fs.existsSync(file)) continue; \
        const pkg = JSON.parse(fs.readFileSync(file, "utf8")); \
        for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) delete pkg[field]; \
        fs.writeFileSync(file, JSON.stringify(pkg, null, 2)); \
      }'
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --lockfile-only && \
    bun install --frozen-lockfile --production

# 4) Distroless runner: COPY only. nonroot (65534), no shell, ENTRYPOINT is bun.
FROM oven/bun:1.4.2-distroless AS runner
WORKDIR /app

# MCP registry ownership proof: publish-mcp.yml publishes server.json listing
# this image as its OCI package, and the registry pulls the image to check this
# label matches the server name. Must stay in sync with `name` in server.json.
LABEL io.modelcontextprotocol.server.name="io.github.ljcl/gaggiuino-mcp"

# Root-owned on purpose. The server runs as 65534 and persists nothing to disk,
# so it needs to read its code, never to write it; files owned by the runtime
# user are files a compromised process can rewrite and have run on the next
# start. World-readable is all 65534 needs, and it is COPY's default.
COPY --from=prod-deps /app ./
COPY --from=builder  /app/apps/server/src ./apps/server/src
COPY --from=builder  /app/apps/server/scripts ./apps/server/scripts
COPY --from=builder  /app/packages/shot-graph/dist ./packages/shot-graph/dist

USER 65534:65534
ENV NODE_ENV=production
EXPOSE 8000

# Exec-form healthcheck: no shell, no wget. Full bun path because HEALTHCHECK
# does not route through ENTRYPOINT. It reads PORT from the container's own
# environment (env_file in compose): under network_mode: host, changing PORT
# is how a user avoids a clash, and a probe pinned to 8000 then reports a
# serving container as unhealthy — which breaks service_healthy dependants and
# auto-restarters.
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD ["/usr/local/bin/bun","--eval","fetch('http://localhost:'+(process.env.PORT||'8000')+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# ENTRYPOINT is already /usr/local/bin/bun, so CMD omits the leading "bun".
CMD ["run","apps/server/src/index.ts"]
