# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f src/apiserver/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:20-slim AS build
WORKDIR /app

# Prisma needs OpenSSL present on Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY src/shared/package.json ./src/shared/
COPY src/apiserver/package.json ./src/apiserver/
COPY src/web/package.json ./src/web/
RUN npm ci --omit=optional

# Sources needed to build the control plane
COPY src/shared ./src/shared
COPY src/apiserver ./src/apiserver
RUN npm run build -w @orbit/shared \
 && npm run prisma:generate -w @orbit/apiserver \
 && npm run build -w @orbit/apiserver

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
COPY --from=build /app/src/shared/package.json ./src/shared/package.json
COPY --from=build /app/src/shared/dist ./src/shared/dist
COPY --from=build /app/src/apiserver/package.json ./src/apiserver/package.json
COPY --from=build /app/src/apiserver/dist ./src/apiserver/dist
COPY --from=build /app/src/apiserver/prisma ./src/apiserver/prisma

EXPOSE 3000
# Apply migrations, then start the API.
CMD ["sh", "-c", "node node_modules/prisma/build/index.js migrate deploy --schema src/apiserver/prisma/schema.prisma && node src/apiserver/dist/main.js"]
