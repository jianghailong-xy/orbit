#!/usr/bin/env bash
# Boot the two images this repository builds and hold each to the predicate
# docker-compose.yml holds it to.
#
# WHY A BOOT AND NOT JUST A BUILD
# On 2026-09-09 a dependabot bump (prisma 7.9.1 -> 7.10.0, `2eead690`) BUILT the apiserver image
# successfully and then crash-looped every start: npm hoisted the `prisma` CLI out of the
# workspace tree that the boot command named outright, and the site served 502 until `003abb91`
# reverted it. A `docker build` gate would have gone green on that commit. The gate has to run
# the image.
#
# THE IMAGE'S OWN CMD IS WHAT RUNS HERE
# No command is passed to `docker run`. That is the difference between this check and the deploy
# script's pre-flight `migrate deploy` (.agents/skills/upgrade/scripts/upgrade.sh), which retypes
# the command into `$DC run` and therefore cannot witness a CMD that is itself broken.
#
# EVERY VERDICT READS CONTAINER STATE
# `docker run -d` exiting 0 means a container was created, not that it is still alive a second
# later; the same is true of `docker compose up -d`. Each wait below polls `.State.Status` and
# fails the moment it reads `exited`, with that container's logs.
set -euo pipefail

APISERVER_IMAGE="${ORBIT_APISERVER_IMAGE:-orbit-apiserver:ci}"
WEB_IMAGE="${ORBIT_WEB_IMAGE:-orbit-web:ci}"

# Unique per invocation: this script also runs on developer hosts that carry other sessions'
# containers, and nothing below may ever match by pattern.
PREFIX="${ORBIT_IMAGE_BOOT_PREFIX:-orbit-image-boot-$$}"
NET="$PREFIX-net"
PG="$PREFIX-postgres"
API="$PREFIX-apiserver"
WEB="$PREFIX-web"

cleanup() {
  # Exact names only, and `-v` so the throwaway database leaves no anonymous volume behind.
  docker rm -fv "$WEB" "$API" "$PG" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

die() {
  echo "!! $*" >&2
  for c in "$API" "$WEB"; do
    if docker inspect "$c" >/dev/null 2>&1; then
      echo "---- docker logs $c (last 60) ----" >&2
      docker logs --tail 60 "$c" >&2 2>&1 || true
    fi
  done
  exit 1
}

step() { echo; echo "==> $*"; }

docker network create "$NET" >/dev/null

# ─────────────────────────────── postgres ───────────────────────────────
# tmpfs PGDATA: this database is thrown away at the end of the job and must not survive as an
# anonymous volume on a developer's disk.
step "Starting throwaway PostgreSQL"
docker run -d --name "$PG" --network "$NET" --network-alias postgres \
  -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit -e POSTGRES_DB=orbit \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  --tmpfs /var/lib/postgresql/data:rw,size=1g \
  postgres:16-alpine >/dev/null

# Over TCP, not the unix socket: initdb runs a temporary socket-only server first, so a socket
# probe reports ready while the real server does not exist yet. That race has already produced a
# false red on GitHub Actions once (run 34214602455).
pg_ready() {
  docker exec -e PGPASSWORD=orbit "$PG" \
    psql -h 127.0.0.1 -U orbit -d postgres -tAc 'SELECT 1' >/dev/null 2>&1
}
for _ in $(seq 1 90); do pg_ready && break; sleep 1; done
pg_ready || die "PostgreSQL never accepted a TCP connection"

# ─────────────────────────────── apiserver ───────────────────────────────
# The four variables the image actually requires. `postgres` resolves over the network alias
# above, exactly as it does in docker-compose.yml.
step "Booting $APISERVER_IMAGE"
docker run -d --name "$API" --network "$NET" --network-alias apiserver \
  -e DATABASE_URL="postgresql://orbit:orbit@postgres:5432/orbit?schema=public" \
  -e JWT_SECRET="$(openssl rand -base64 32)" \
  -e PROVIDER_SECRET_KEY="$(openssl rand -base64 32)" \
  -e PORT=3000 \
  "$APISERVER_IMAGE" >/dev/null

# docker-compose.yml's own healthcheck, verbatim: any HTTP response means Nest is listening, and
# only a refused connection fails.
api_healthy() {
  docker exec "$API" node -e "fetch('http://127.0.0.1:3000/api').then(()=>process.exit(0)).catch(()=>process.exit(1))" \
    >/dev/null 2>&1
}
for _ in $(seq 1 240); do
  [ "$(docker inspect -f '{{.State.Status}}' "$API")" = exited ] \
    && die "apiserver exited (code $(docker inspect -f '{{.State.ExitCode}}' "$API")) instead of listening"
  api_healthy && break
  sleep 1
done
api_healthy || die "apiserver never answered on :3000 within 240s"
echo "   apiserver is listening"

# `migrate deploy` can exit 0 having applied nothing — that is what a Dockerfile which stopped
# COPYing src/apiserver/prisma would look like, and the container would still come up healthy.
# Count the rows instead of trusting the exit code.
applied="$(docker exec -e PGPASSWORD=orbit "$PG" psql -h 127.0.0.1 -U orbit -d orbit -tAc \
  'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' 2>/dev/null | tr -d '[:space:]')"
[ -n "$applied" ] && [ "$applied" -gt 0 ] 2>/dev/null \
  || die "the image booted but applied no migrations (_prisma_migrations reported '${applied:-<none>}')"
echo "   migrations applied: $applied"

# ────────────────────────────────── web ──────────────────────────────────
# nginx resolves `proxy_pass http://apiserver:3000` at config load, so a web container that
# answers anything at all has already resolved the apiserver on this network. /healthz is
# therefore the whole predicate, and it is the one compose waits on.
step "Booting $WEB_IMAGE"
docker run -d --name "$WEB" --network "$NET" --network-alias web "$WEB_IMAGE" >/dev/null

web_healthy() { docker exec "$WEB" wget -q -O /dev/null http://127.0.0.1/healthz >/dev/null 2>&1; }
for _ in $(seq 1 60); do
  [ "$(docker inspect -f '{{.State.Status}}' "$WEB")" = exited ] \
    && die "web exited (code $(docker inspect -f '{{.State.ExitCode}}' "$WEB")) instead of serving"
  web_healthy && break
  sleep 1
done
web_healthy || die "web never answered /healthz within 60s"
echo "   web is serving, and nginx resolved the apiserver upstream"

# The runner binaries are built in a stage of their own and served from /dl; an empty directory
# there is a build that quietly produced nothing.
count="$(docker exec "$WEB" sh -c 'ls -1 /usr/share/nginx/html/dl 2>/dev/null | wc -l' | tr -d '[:space:]')"
[ -n "$count" ] && [ "$count" -gt 0 ] 2>/dev/null \
  || die "the web image ships no runner binaries under /dl"
echo "   runner binaries served: $count"

step "Both images built, booted and answered."
