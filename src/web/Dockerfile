# syntax=docker/dockerfile:1
# Build context is the repo root. A Git checkout identifies its own source commit; build
# from a tree without Git metadata and the commit must be named explicitly:
# docker build --build-arg ORBIT_SOURCE_SHA="$(git rev-parse HEAD)" -f src/web/Dockerfile .

# The web image this build replaces, whose runner release stays downloadable at /dl/previous/
# (see the runtime stage). upgrade.sh names the image now serving; a build that names none keeps no
# previous release, and runners can then be neither held at one nor rolled back to one.
ARG PREVIOUS_RELEASE_IMAGE=scratch

# ───────────────────────────────── build ─────────────────────────────────
FROM node:26-alpine AS build
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
FROM golang:1.27 AS binbuild
WORKDIR /app
COPY src/runner-go ./src/runner-go
COPY package.json ./package.json
COPY scripts ./scripts
COPY contracts/runner-write-protocol.json ./contracts/runner-write-protocol.json
# The commit this build stamps into the binaries, when ORBIT_SOURCE_SHA was not passed:
# .git/HEAD plus the refs, which is all the .dockerignore lets through. Bracketed so a
# source tree without Git metadata still builds (it must then pass ORBIT_SOURCE_SHA).
COPY .gi[t] ./.git/
# Bake this deployment's public origin into the runner binary's defaultServer (see
# build-binaries.sh) so a self-hosted runner's `orbit register` needs no --server.
ARG PUBLIC_ORIGIN
ARG ORBIT_SOURCE_SHA
ENV PUBLIC_ORIGIN=$PUBLIC_ORIGIN
RUN --mount=type=cache,target=/root/.cache/go-build \
    ORBIT_SOURCE_SHA="$ORBIT_SOURCE_SHA" bash scripts/build-binaries.sh dist-bin

# The image PREVIOUS_RELEASE_IMAGE names, whose /dl the runtime stage reads (empty: scratch).
FROM ${PREVIOUS_RELEASE_IMAGE} AS previous-release

# ──────────────────────────────── runtime ────────────────────────────────
FROM nginx:alpine AS runtime
ARG PUBLIC_ORIGIN
COPY src/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/src/web/dist /usr/share/nginx/html
COPY --from=binbuild /app/dist-bin /usr/share/nginx/html/dl
# The release the replaced image published, kept at /dl/previous/ beside this one's: the release the
# control plane holds runners at during a staged rollout and rolls them back to
# (src/apiserver/src/runner-api/runner-release.ts).
RUN --mount=type=bind,from=previous-release,target=/previous-release \
    --mount=type=bind,source=scripts/retain-runner-release.sh,target=/tmp/retain-runner-release.sh \
    sh /tmp/retain-runner-release.sh /previous-release/usr/share/nginx/html/dl /usr/share/nginx/html/dl
# install.sh is a static asset (Vite copies it verbatim, no substitution), so rewrite its
# baked-in default BASE_URL to this deployment's origin — then `curl .../install.sh | bash`
# pulls the runner from here with no ORBIT_BASE_URL override.
RUN if [ -n "$PUBLIC_ORIGIN" ]; then \
      sed -i "s|https://orbitd.io|$PUBLIC_ORIGIN|g" /usr/share/nginx/html/install.sh; \
    fi
EXPOSE 80
