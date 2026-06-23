# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f src/web/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY src/shared/package.json ./src/shared/
COPY src/apiserver/package.json ./src/apiserver/
COPY src/web/package.json ./src/web/
# NOTE: plain `npm ci` (no --omit=optional) — Vite/rollup need their platform-native
# optional package (e.g. @rollup/rollup-linux-*-musl), which --omit=optional would drop.
RUN npm ci

COPY src/web ./src/web
COPY src/shared ./src/shared
RUN npm run build -w @orbit/shared
# Public origin baked into the web bundle (the "Add a runner" install commands). Declared
# here, after npm ci and the shared build, so changing it only rebuilds the web bundle.
ARG PUBLIC_ORIGIN
ENV PUBLIC_ORIGIN=$PUBLIC_ORIGIN
RUN npm run build -w @orbit/web

# ───────────────────────── runner binaries (Go, static) ─────────────────────────
# Standalone `orbit` executables (gzip-compressed, ~2.4 MB each) served at /dl,
# consumed by /install.sh and the runner's self-update — both decompress with
# stdlib gzip. Go cross-compiles trivially with no external deps.
FROM golang:1.23 AS binbuild
WORKDIR /app
COPY src/runner-go ./src/runner-go
COPY package.json ./package.json
COPY scripts ./scripts
# Bake this deployment's public origin into the runner binary's defaultServer (see
# build-binaries.sh) so a self-hosted runner's `orbit register` needs no --server.
ARG PUBLIC_ORIGIN
ENV PUBLIC_ORIGIN=$PUBLIC_ORIGIN
RUN bash scripts/build-binaries.sh dist-bin

# ──────────────────────────────── runtime ────────────────────────────────
FROM nginx:alpine AS runtime
ARG PUBLIC_ORIGIN
COPY src/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/src/web/dist /usr/share/nginx/html
COPY --from=binbuild /app/dist-bin /usr/share/nginx/html/dl
# install.sh is a static asset (Vite copies it verbatim, no substitution), so rewrite its
# baked-in default BASE_URL to this deployment's origin — then `curl .../install.sh | bash`
# pulls the runner from here with no ORBIT_BASE_URL override.
RUN if [ -n "$PUBLIC_ORIGIN" ]; then \
      sed -i "s|https://orbit.wikova.com|$PUBLIC_ORIGIN|g" /usr/share/nginx/html/install.sh; \
    fi
EXPOSE 80
