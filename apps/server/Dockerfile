FROM oven/bun:1.3.6 AS base
WORKDIR /app

# Build UI (only install packages needed for shot-graph build)
FROM base AS ui-builder
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shot-graph/package.json packages/shot-graph/
COPY packages/design-system/package.json packages/design-system/
RUN bun install --frozen-lockfile --ignore-scripts
COPY packages/ packages/
RUN cd packages/shot-graph && INPUT=app.html bunx vite build

# Install server production deps only
FROM base AS server-deps
COPY package.json bun.lock ./
COPY apps/server/package.json apps/server/
COPY packages/tsconfig/package.json packages/tsconfig/
COPY packages/shot-graph/package.json packages/shot-graph/
COPY packages/design-system/package.json packages/design-system/
RUN cd apps/server && bun install --production --frozen-lockfile --ignore-scripts

# Runner
FROM base AS runner
COPY --from=server-deps /app/node_modules ./node_modules
COPY --from=server-deps /app/apps/server/node_modules ./apps/server/node_modules
COPY apps/server/src ./apps/server/src
COPY apps/server/package.json ./apps/server/
COPY --from=ui-builder /app/dist ./dist

ENV NODE_ENV=production
EXPOSE 8000
CMD ["bun", "run", "apps/server/src/index.ts"]
