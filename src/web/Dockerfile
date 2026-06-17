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
RUN bash scripts/build-binaries.sh dist-bin

# ──────────────────────────────── runtime ────────────────────────────────
FROM nginx:alpine AS runtime
COPY src/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/src/web/dist /usr/share/nginx/html
COPY --from=binbuild /app/dist-bin /usr/share/nginx/html/dl
EXPOSE 80
