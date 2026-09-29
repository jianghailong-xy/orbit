# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f src/apiserver/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:26-slim AS build
WORKDIR /app

# No OpenSSL install step: what Prisma's engines need is libssl's shared objects — `node:26-slim`
# is Debian trixie and already carries them (`libssl3t64`), and the schema engine we boot with is
# literally named `schema-engine-debian-openssl-3.0.x`. The `openssl` CLI is never invoked, so an
# apt layer here bought nothing and cost the build a dependency on a reachable Debian mirror: on
# 2026-09-18 a deployment's resolver answered for deb.debian.org with unroutable addresses and the
# whole upgrade died at this line on `E: Unable to locate package openssl`.

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

# ───────────────────────────────── codex ─────────────────────────────────
# The official codex CLI: "Sign in with ChatGPT" for a Codex pool of one's own runs
# `codex login --device-auth` on this server (providers/codex-login.service.ts). Pinned to the
# version the runners run. npm is only how it is fetched: the package's own `codex` is a Node
# wrapper that starts the native binary as a child of its own, and the sign-in ends an attempt with
# SIGKILL, which the wrapper cannot pass on — the native CLI would outlive it, still waiting on the
# code. So what ships is the platform package's standalone layout (the one a runner's standalone
# install unpacks), and `codex` on PATH is its native binary. No match here fails the build: npm
# only warns when an optional dependency — which is how the platform package arrives — is missing.
FROM node:26-slim AS codex
RUN npm install -g @openai/codex@0.158.0 \
 && mv /usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-linux-*/vendor/*-unknown-linux-musl /opt/codex

# ──────────────────────────────── runtime ────────────────────────────────
FROM node:26-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

# Same as the build stage: the runtime needs libssl's shared objects, which the base image ships,
# not the `openssl` CLI.

# The codex CLI (see the codex stage), and the roots it trusts: the native binary verifies TLS
# against the system's CA certificates, which this base image does not have, and without them
# `codex login --device-auth` dies on its first request to auth.openai.com. They are written out
# of the Mozilla store Node itself carries rather than installed with apt, so this image still
# builds without a Debian mirror. `--version` proves the binary runs here; what it leaves in
# ~/.codex is removed.
COPY --from=codex /opt/codex /opt/codex
RUN ln -s /opt/codex/bin/codex /usr/local/bin/codex \
 && mkdir -p /etc/ssl/certs \
 && node -p "require('tls').rootCertificates.join('\n')" > /etc/ssl/certs/ca-certificates.crt \
 && codex --version \
 && rm -rf /root/.codex

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
CMD ["sh", "-c", "cd src/apiserver && node \"$(node -p 'require.resolve(\"prisma/build/index.js\")')\" migrate deploy && cd /app && node src/apiserver/dist/main.js"]
