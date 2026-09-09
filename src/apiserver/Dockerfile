# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f src/apiserver/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:26-slim AS build
WORKDIR /app

# Prisma needs OpenSSL present on Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# Manifests first for layer caching
COPY package.json package-lock.json tsconfig.base.json ./
COPY src/shared/package.json ./src/shared/
COPY src/apiserver/package.json ./src/apiserver/
COPY src/web/package.json ./src/web/
# NOTE: plain `npm ci` (no --omit=optional) — TypeScript 7 is a native binary shipped in a
# platform-specific optional package (@typescript/typescript-linux-*), which --omit=optional
# would drop, leaving `tsc` unable to resolve its executable.
RUN npm ci

# Sources needed to build the control plane
COPY src/shared ./src/shared
COPY src/apiserver ./src/apiserver
RUN npm run build -w @orbit/shared \
 && npm run prisma:generate -w @orbit/apiserver \
 && npm run build -w @orbit/apiserver

# ──────────────────────────────── runtime ────────────────────────────────
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Prisma needs OpenSSL present on Debian slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
 && rm -rf /var/lib/apt/lists/*

# node_modules carries the generated Prisma client + the prisma CLI used at boot. WHICH tree npm
# puts them in is a resolution outcome and not a contract: 7.9.1 kept `prisma`/`@prisma/client` in
# the workspace's own node_modules, 7.10.0 hoisted them to the root, and the boot command — which
# named the workspace path outright — then could not find the CLI at all (2026-09-09, every start
# died on `Cannot find module '/app/src/apiserver/node_modules/prisma/build/index.js'`). Both trees
# therefore ship, and the CMD below asks Node to find the CLI instead of saying where it is.
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/apiserver/node_modules ./src/apiserver/node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/src/shared/package.json ./src/shared/package.json
COPY --from=build /app/src/shared/dist ./src/shared/dist
COPY --from=build /app/src/apiserver/package.json ./src/apiserver/package.json
COPY --from=build /app/src/apiserver/prisma.config.ts ./src/apiserver/prisma.config.ts
COPY --from=build /app/src/apiserver/dist ./src/apiserver/dist
COPY --from=build /app/src/apiserver/prisma ./src/apiserver/prisma
COPY contracts ./contracts
COPY scripts/executable-acceptance-dead-man.mjs ./scripts/executable-acceptance-dead-man.mjs

EXPOSE 3000
# Apply migrations, then start the API. Prisma 7 takes the connection URL from prisma.config.ts
# instead of the schema, and finds that file relative to the working directory — hence the `cd`.
# `require.resolve` runs the ordinary Node lookup from that same directory, so the CLI is found in
# the workspace's node_modules or in the root one, whichever this install produced; no dependency
# bump can move it somewhere this command refuses to look.
CMD ["sh", "-c", "cd src/apiserver && node node_modules/prisma/build/index.js migrate deploy && cd /app && node src/apiserver/dist/main.js"]
