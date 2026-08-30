#!/usr/bin/env bash
# Unique executable acceptance for runtime-v2. Logical deadlines use virtual clocks or
# millisecond processes. The outer 240-second guard covers compilation, a rolling migration,
# and the serial real-PostgreSQL matrix; each liveness probe retains its own tight deadline.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
BUILD="$REPO/build"
CONTAINER="orbit-executable-acceptance-pg-$$"
ADMIN="exec_acceptance_admin"
PASSWORD="exec_acceptance_pw"
DATABASE="exec_acceptance_runtime"
ROLLING_DATABASE="exec_acceptance_rolling"
IMAGE="${EXECUTABLE_ACCEPTANCE_PG_IMAGE:-postgres:16-alpine}"
TAP="$BUILD/executable-acceptance-runtime.tap"
GO_OUTPUT="$BUILD/executable-acceptance-runtime-go.txt"
EVIDENCE="$BUILD/executable-acceptance-runtime-evidence.json"
ROLLING_EVIDENCE="$BUILD/executable-acceptance-runtime-rolling-evidence.json"
MANIFEST="$BUILD/executable-acceptance-runtime-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
SOURCE_SHA="$(git -C "$REPO" rev-parse HEAD)"
ROLLING_PRISMA="$(mktemp -d /tmp/orbit-executable-rolling.XXXXXX)"

cleanup() {
  if outcome_release_dag_db_enabled; then
    if [[ "${ROLLING_DATABASE:-}" =~ ^ord_[a-z0-9_]{1,56}$ ]]; then
      docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
        -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$ROLLING_DATABASE' AND pid <> pg_backend_pid()" \
        >/dev/null 2>&1 || true
      docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
        -c "DROP DATABASE IF EXISTS \"$ROLLING_DATABASE\"" >/dev/null 2>&1 || true
    fi
    outcome_release_dag_drop_database
  else
    docker rm -fv "$CONTAINER" >/dev/null 2>&1 || true
  fi
  rm -rf "$ROLLING_PRISMA"
}
trap cleanup EXIT

command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo 'docker daemon is unavailable' >&2; exit 1; }
[[ "$SOURCE_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo 'source SHA is not full' >&2; exit 1; }
mkdir -p "$BUILD"

if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
  echo '==> executable-runtime: use exact bound Prisma/Shared/API build'
else
  echo "==> executable-runtime: generate/build protocol sources"
  ( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
  ( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
  # Worktree acceptance may borrow the installed checkout's node_modules. npm's workspace link for
  # @orbit/shared then resolves to that checkout, not this worktree, so refresh the exact package.
  RESOLVED_SHARED_PACKAGE="$(cd "$REPO" && node -p "require.resolve('@orbit/shared/package.json')")"
  if [ "$RESOLVED_SHARED_PACKAGE" != "$REPO/src/shared/package.json" ]; then
    ( cd "$(dirname "$RESOLVED_SHARED_PACKAGE")" && "$REPO/node_modules/.bin/tsc" -p tsconfig.json )
  fi
  ( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )
fi

echo "==> executable-runtime: run short-process runner integration"
( cd "$REPO/src/runner-go" && go test -v -run '^TestExecutableAcceptance' . ) | tee "$GO_OUTPUT"

if outcome_release_dag_db_enabled; then
  echo '==> executable-runtime: clone the bound current database and create one rolling fixture'
  outcome_release_dag_bind_database
  ROLLING_DATABASE="${DATABASE}_rolling"
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$ROLLING_DATABASE\"" >/dev/null
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$ROLLING_DATABASE\" TEMPLATE template0" >/dev/null
  ROLLING_URL="postgresql://$ADMIN:$PASSWORD@$PG_HOST:$PG_PORT/$ROLLING_DATABASE"
else
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
  docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE $ROLLING_DATABASE" >/dev/null
  PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
  PORT="${PORT_LINE##*:}"
  URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$DATABASE"
  ROLLING_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$ROLLING_DATABASE"
fi

echo "==> executable-runtime: seed an IN_FLIGHT v1 turn at the 0192 rollout frontier"
mkdir -p "$ROLLING_PRISMA/migrations"
cp "$API/prisma/schema.prisma" "$ROLLING_PRISMA/"
cp "$API/prisma/migrations/migration_lock.toml" "$ROLLING_PRISMA/migrations/"
for migration in "$API"/prisma/migrations/*/; do
  name="$(basename "$migration")"
  if [[ "$name" < "0193_" ]]; then cp -R "$migration" "$ROLLING_PRISMA/migrations/"; fi
done
DATABASE_URL="$ROLLING_URL" \
ORBIT_FRONTIER_PRISMA_SCHEMA="$ROLLING_PRISMA/schema.prisma" \
ORBIT_FRONTIER_PRISMA_MIGRATIONS="$ROLLING_PRISMA/migrations" \
node "$API/node_modules/prisma/build/index.js" migrate deploy \
  --config "$API/prisma.frontier.config.ts" >/dev/null
EXECUTABLE_ACCEPTANCE_ROLLING_PG_URL="$ROLLING_URL" node \
  "$REPO/scripts/executable-acceptance-rolling-upgrade.mjs" seed
( cd "$API" && DATABASE_URL="$ROLLING_URL" node node_modules/prisma/build/index.js \
  migrate deploy --schema prisma/schema.prisma >/dev/null )

echo "==> executable-runtime: prove the pre-0193 v1 callback survives the rolling upgrade"
EXECUTABLE_ACCEPTANCE_ROLLING_PG_URL="$ROLLING_URL" \
EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH="$ROLLING_EVIDENCE" \
node "$REPO/scripts/executable-acceptance-rolling-upgrade.mjs" verify

if ! outcome_release_dag_db_enabled; then
  echo "==> executable-runtime: deploy all migrations"
  ( cd "$API" && DATABASE_URL="$URL" node node_modules/prisma/build/index.js \
    migrate deploy --schema prisma/schema.prisma >/dev/null )
fi

echo "==> executable-runtime: run zero-skip API/DB/dead-man matrix"
set +e
EXECUTABLE_ACCEPTANCE_PG_URL="$URL" \
EXECUTABLE_ACCEPTANCE_EVIDENCE_PATH="$EVIDENCE" \
EXECUTABLE_ACCEPTANCE_ROLLING_EVIDENCE_PATH="$ROLLING_EVIDENCE" \
EXECUTABLE_ACCEPTANCE_SOURCE_SHA="$SOURCE_SHA" \
timeout -k 5 240 node --test --test-concurrency=1 --test-reporter=tap \
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
