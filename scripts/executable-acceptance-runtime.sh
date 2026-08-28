#!/usr/bin/env bash
# Unique executable acceptance for runtime-v2. All time-based cases use virtual clocks or
# millisecond processes; the harness itself is designed to finish inside the old 120-second shell.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="orbit-executable-acceptance-pg-$$"
ADMIN="exec_acceptance_admin"
PASSWORD="exec_acceptance_pw"
DATABASE="exec_acceptance_runtime"
IMAGE="${EXECUTABLE_ACCEPTANCE_PG_IMAGE:-postgres:16-alpine}"
TAP="$BUILD/executable-acceptance-runtime.tap"
GO_OUTPUT="$BUILD/executable-acceptance-runtime-go.txt"
EVIDENCE="$BUILD/executable-acceptance-runtime-evidence.json"
MANIFEST="$BUILD/executable-acceptance-runtime-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SOURCE_SHA="$(git -C "$REPO" rev-parse HEAD)"

cleanup() {
  docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is unavailable' >&2; exit 1; }
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'source SHA is not full' >&2; exit 1; }
mkdir -p "$BUILD"

echo "==> executable-runtime: generate/build protocol sources"
( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )

echo "==> executable-runtime: run short-process runner integration"
( cd "$REPO/src/runner-go" && go test -v -run '^TestExecutableAcceptance' . ) | tee "$GO_OUTPUT"

echo "==> executable-runtime: provision disposable PostgreSQL"
docker run -d --name "$CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=768m \
  -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
  -p 127.0.0.1::5432 "$IMAGE" >/dev/null
READY=0
for _ in $(seq 1 30); do
  if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
[ "$READY" = 1 ] || { echo 'disposable PostgreSQL did not become ready' >&2; exit 1; }
docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
  -c "CREATE DATABASE $DATABASE" >/dev/null
PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
PORT="${PORT_LINE##*:}"
URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"

echo "==> executable-runtime: deploy all migrations"
( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )

echo "==> executable-runtime: run zero-skip API/DB/dead-man matrix"
set +e
EXECUTABLE_ACCEPTANCE_PG_URL="$URL" \
EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH="$EVIDENCE" \
EXECUTABLE_ACCEPTANCE_SOURCE_SHA="$SOURCE_SHA" \
timeout -k 5 70 node --test --test-concurrency=1 --test-reporter=tap \
  "$REPO/test/executable-acceptance-runtime.test.mjs" 2>&1 | tee "$TAP"
TEST_RC=${PIPESTATUS[0]}
set -e
if [ "$TEST_RC" -ne 0 ]; then
  echo "executable runtime acceptance failed rc=$TEST_RC" >&2
  exit "$TEST_RC"
fi

echo "==> executable-runtime: generate SHA-bound manifest from raw evidence"
EXECUTABLE_ACCEPTANCE_STARTED_AT="$STARTED_AT" node \
  "$REPO/scripts/executable-acceptance-runtime-manifest.mjs" \
  "$TAP" "$EVIDENCE" "$GO_OUTPUT" "$MANIFEST"
