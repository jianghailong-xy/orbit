# syntax=docker/dockerfile:1
# Build context is the repo root: docker build -f packages/web/Dockerfile .

# ───────────────────────────────── build ─────────────────────────────────
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/server/package.json ./packages/server/
COPY packages/runner/package.json ./packages/runner/
COPY packages/web/package.json ./packages/web/
# NOTE: plain `npm ci` (no --omit=optional) — Vite/rollup need their platform-native
# optional package (e.g. @rollup/rollup-linux-*-musl), which --omit=optional would drop.
RUN npm ci

COPY packages/web ./packages/web
RUN npm run build -w @orbit/web

# ──────────────────────────────── runtime ────────────────────────────────
FROM nginx:alpine AS runtime
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80
