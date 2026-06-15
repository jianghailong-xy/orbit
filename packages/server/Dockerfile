# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f packages/server/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Prisma needs OpenSSL present on Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/runner/package.json ./packages/runner/
COPY packages/web/package.json ./packages/web/
RUN npm ci --omit=optional

# Sources needed to build the control plane
COPY packages/shared ./packages/shared
COPY packages/server ./packages/server
RUN npm run build -w @orbit/shared \
 && npm run prisma:generate -w @orbit/server \
 && npm run build -w @orbit/server

# ──────────────────────────────── runtime ────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL present on Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# node_modules carries the generated Prisma client + the prisma CLI used at boot.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/server/package.json ./packages/server/package.json
COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/server/prisma ./packages/server/prisma

EXPOSE 3000
# Apply migrations, then start the API.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema packages/server/prisma/schema.prisma && node packages/server/dist/main.js"]
