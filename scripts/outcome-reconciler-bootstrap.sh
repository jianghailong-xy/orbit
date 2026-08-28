#!/usr/bin/env bash
# Self-contained acceptance for the self-hosting merge/writer fence and mixed runner protocol.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/orbit-bootstrap.XXXXXX")"
CONTAINER="orbit-bootstrap-pg-$$"
DB="pccbootstrap_db"
DB_USER="pccbootstrap_admin"
DB_PASSWORD="orbit_bootstrap_password"
IMAGE="${ORBIT_BOOTSTRAP_PG_IMAGE:-postgres:16-alpine}"
MANIFEST="$REPO/build/outcome-reconciler-bootstrap-manifest.json"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
  rm -rf "$TMP"
}
trap cleanup EXIT

echo "==> bootstrap: build shared contract and generate Prisma client"
( cd "$REPO" && npm run build -w @orbit/shared )
( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver )

echo "==> bootstrap: provision isolated PostgreSQL ($CONTAINER)"
docker run -d --name "$CONTAINER" \
  -e "POSTGRES_USER=$DB_USER" -e "POSTGRES_PASSWORD=$DB_PASSWORD" -e "POSTGRES_DB=$DB" \
  -p '127.0.0.1::5432' "$IMAGE" >/dev/null
PORT="$(docker inspect --format '{{(index (index .NetworkSettings.Ports "5432/tcp") 0).HostPort}}' "$CONTAINER")"
URL="postgresql://$DB_USER:$DB_PASSWORD@127.0.0.1:$PORT/$DB"
for _ in $(seq 1 90); do
  docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -tAc 'SELECT 1' >/dev/null 2>&1 && break
  sleep 1
done
docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -tAc 'SELECT 1' >/dev/null
SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$DB_USER" -d "$DB" -tAc \
  'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"

echo "==> bootstrap: migrate empty database"
( cd "$API" && DATABASE_URL="$URL" ./node_modules/.bin/prisma migrate deploy \
  --schema prisma/schema.prisma >/dev/null )

echo "==> bootstrap: compile server and focused acceptance tree"
( cd "$API" && ./node_modules/.bin/tsc -p tsconfig.test.json )

TS_TAP="$TMP/typescript.tap"
echo "==> bootstrap: protocol, merge fence, writer fence and inventory tests"
if ! ( cd "$API" && \
  COORDINATOR_PG_URL="$URL" \
  COORDINATOR_PG_EXPECTED_DATABASE="$DB" \
  COORDINATOR_PG_EXPECTED_USER="$DB_USER" \
  COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
  NODE_OPTIONS='' node --test --test-concurrency=1 --test-reporter=tap \
    build/runner-api/runner-write-protocol.spec.js \
    build/runner-api/runner-tasks.controller.spec.js \
    build/projects/bootstrap-delivery-fence.spec.js \
    build/tasks/task-done-writer-fence.pg.spec.js \
    build/tasks/task-status-derived-end-to-end.pg.spec.js \
    build/common/db-write-inventory.spec.js >"$TS_TAP" 2>&1 ); then
  cat "$TS_TAP"
  exit 1
fi
cat "$TS_TAP"
. "$REPO/scripts/pg-matrix-summary.lib.sh"
IFS=$'\t' read -r TS_TESTS TS_PASS TS_FAIL TS_SKIP TS_BAD < <(pg_matrix_summary < "$TS_TAP")
if [ -n "$TS_BAD" ] || [ "$TS_TESTS" -le 0 ] || [ "$TS_FAIL" -ne 0 ] || [ "$TS_SKIP" -ne 0 ]; then
  echo "bootstrap TypeScript summary refused: ${TS_BAD:-tests=$TS_TESTS fail=$TS_FAIL skip=$TS_SKIP}"
  exit 1
fi

GO_JSON="$TMP/go-test.json"
echo "==> bootstrap: runner headers, capability contract, upgrade and rollback tests"
if ! ( cd "$REPO/src/runner-go" && go test -json -count=1 \
  -run 'Test(CapabilitiesJSONUsesMCPDescriptorsAndExposesOnlyPhase1|RunnerWriteContractGeneratedFromRepositoryContract|UpgradeAndRollbackManifestCompatibility|DownloadedCLIContractMustMatchReleaseManifest|TransportAdvertisesSupportedProviders|AvailableSelfUpdate)' \
  . >"$GO_JSON" 2>&1 ); then
  cat "$GO_JSON"
  exit 1
fi
cat "$GO_JSON"

CLI_JSON="$TMP/capabilities.json"
( cd "$REPO/src/runner-go" && ORBIT_HOME="$TMP/orbit-home" go run . capabilities --json > "$CLI_JSON" )

echo "==> bootstrap: write machine-readable manifest"
BOOTSTRAP_STARTED_AT="$STARTED_AT" \
BOOTSTRAP_DATABASE="$DB" \
BOOTSTRAP_DATABASE_SYSTEM_IDENTIFIER="$SYSTEM_ID" \
node "$REPO/scripts/outcome-reconciler-bootstrap-manifest.mjs" \
  "$TS_TAP" "$GO_JSON" "$CLI_JSON" "$MANIFEST"
echo "==> bootstrap manifest: $MANIFEST"
