#!/usr/bin/env bash
# Canonical Work overview readiness. All 22 test assertions always run against disposable state.
# A predeploy DAG invocation emits a typed deployment deferral; standalone postdeploy use performs
# the live read-only checks. Neither mode starts a task.
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$REPO/scripts/lib/outcome-reconciler-release-dag.sh"
API="$REPO/src/apiserver"
WEB="$REPO/src/web"
BUILD="$REPO/build"
PG_CONTAINER="${WORK_OVERVIEW_PG_CONTAINER:-orbit-work-overview-pg-$$}"
PG_USER="${WORK_OVERVIEW_PG_USER:-pcc_work_overview_admin}"
PG_PASSWORD="${WORK_OVERVIEW_PG_PASSWORD:-work_overview_fixture_pw}"
PG_DATABASE="${WORK_OVERVIEW_PG_DATABASE:-pcc_work_overview_$$_fixture}"
PG_IMAGE="${WORK_OVERVIEW_PG_IMAGE:-postgres:16-alpine}"
TARGET_SHA="$(git -C "$REPO" rev-parse HEAD)"
EVIDENCE_PHASE="${OUTCOME_RELEASE_DAG_PHASE:-POSTDEPLOY_CURRENT_BINDING}"
case "$EVIDENCE_PHASE" in
  PREDEPLOY_EVALUATION)
    MAIN_SHA="$(git -C "$REPO" rev-parse refs/remotes/origin/main)"
    [ "${OUTCOME_RELEASE_DAG_TARGET_SHA:-}" = "$TARGET_SHA" ] || {
      echo '!! predeploy work-overview target differs from the Release DAG binding' >&2
      exit 1
    }
    ;;
  POSTDEPLOY_CURRENT_BINDING)
    MAIN_SHA="$(git -C "$REPO" rev-parse refs/heads/main)"
    ;;
  *)
    echo "!! unsupported work-overview evidence phase: $EVIDENCE_PHASE" >&2
    exit 2
    ;;
esac
BASE_SHA="21e019a47adffe018a7539163c9fc3e0ab83c6cc"
MAIN_WORKTREE="${WORK_OVERVIEW_MAIN_WORKTREE:-/root/orbit}"
STARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
PROVIDER="${WORK_OVERVIEW_PROVIDER:-codex}"
PG_TAP="$BUILD/work-overview-readiness-pg.tap"
WEB_TAP="$BUILD/work-overview-readiness-web.tap"
PHONE_HTML="$BUILD/work-overview-readiness-phone.html"
DOM_EVIDENCE="$BUILD/work-overview-readiness-dom.json"
SCREENSHOT="$BUILD/work-overview-readiness-phone-390x844.png"
LIVE_EVIDENCE="$BUILD/work-overview-readiness-live.json"
MANIFEST="$BUILD/work-overview-readiness-manifest.json"
ROOT_MODULE_LINK=0
API_MODULE_LINK=0
WEB_MODULE_LINK=0
SHARED_MODULE_LINK=0
PG_STARTED=0

cleanup() {
  if outcome_release_dag_db_enabled; then
    outcome_release_dag_drop_database
  elif [ "$PG_STARTED" = "1" ]; then
    docker rm -fv "$PG_CONTAINER" >/dev/null 2>&1 || true
  fi
  if [ "$SHARED_MODULE_LINK" = "1" ] && [ -L "$REPO/src/shared/node_modules" ]; then
    unlink "$REPO/src/shared/node_modules"
  fi
  if [ "$WEB_MODULE_LINK" = "1" ] && [ -L "$WEB/node_modules" ]; then unlink "$WEB/node_modules"; fi
  if [ "$API_MODULE_LINK" = "1" ] && [ -L "$API/node_modules" ]; then unlink "$API/node_modules"; fi
  if [ "$ROOT_MODULE_LINK" = "1" ] && [ -L "$REPO/node_modules" ]; then unlink "$REPO/node_modules"; fi
}
trap cleanup EXIT

[[ "$TARGET_SHA" =~ ^[0-9a-f]{40}$ ]] || { echo '!! target SHA is not full' >&2; exit 1; }
git -C "$REPO" merge-base --is-ancestor "$BASE_SHA" "$TARGET_SHA" || {
  echo "!! task base $BASE_SHA is not an ancestor of target $TARGET_SHA" >&2
  exit 1
}
[ "$MAIN_SHA" = "$TARGET_SHA" ] || {
  echo "!! HEAD $TARGET_SHA is not refs/heads/main $MAIN_SHA" >&2
  exit 1
}
[ -z "$(git -C "$REPO" status --porcelain --untracked-files=no)" ] || {
  echo '!! acceptance workspace has tracked changes' >&2
  exit 1
}
if [ "$EVIDENCE_PHASE" = POSTDEPLOY_CURRENT_BINDING ]; then
  [ "$(git -C "$MAIN_WORKTREE" rev-parse HEAD)" = "$TARGET_SHA" ] || {
    echo '!! clean deployment worktree is not at target SHA' >&2
    exit 1
  }
  [ -z "$(git -C "$MAIN_WORKTREE" status --porcelain --untracked-files=no)" ] || {
    echo '!! deployment worktree has tracked changes' >&2
    exit 1
  }
fi
command -v docker >/dev/null || { echo '!! docker is required' >&2; exit 1; }
command -v chromium >/dev/null || { echo '!! chromium is required for phone evidence' >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo '!! docker daemon is unavailable' >&2; exit 1; }
mkdir -p "$BUILD"

if [ ! -e "$REPO/node_modules" ] && [ ! -L "$REPO/node_modules" ]; then
  [ -d /root/orbit/node_modules ] || { echo '!! root Node dependencies unavailable' >&2; exit 1; }
  ln -s /root/orbit/node_modules "$REPO/node_modules"
  ROOT_MODULE_LINK=1
fi
if [ ! -e "$API/node_modules" ] && [ ! -L "$API/node_modules" ]; then
  ln -s /root/orbit/src/apiserver/node_modules "$API/node_modules"
  API_MODULE_LINK=1
fi
if [ ! -e "$WEB/node_modules" ] && [ ! -L "$WEB/node_modules" ]; then
  ln -s /root/orbit/src/web/node_modules "$WEB/node_modules"
  WEB_MODULE_LINK=1
fi
if [ ! -e "$REPO/src/shared/node_modules" ] && [ ! -L "$REPO/src/shared/node_modules" ]; then
  ln -s /root/orbit/src/shared/node_modules "$REPO/src/shared/node_modules"
  SHARED_MODULE_LINK=1
fi

echo '==> work-overview: build target API, test runtime, and Web artifact'
if [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ]; then
  outcome_release_dag_assert_build
else
  ( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
  ( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
  ( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )
  ( cd "$API" && "$REPO/node_modules/.bin/tsc" -p tsconfig.test.json )
  PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN:-}"
  if [ -z "$PUBLIC_ORIGIN_VALUE" ] && [ -f "$MAIN_WORKTREE/.env" ]; then
    PUBLIC_ORIGIN_VALUE="$(sed -n 's/^PUBLIC_ORIGIN=//p' "$MAIN_WORKTREE/.env" | tail -n 1)"
    PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE%$'\r'}"
    if [[ "$PUBLIC_ORIGIN_VALUE" == \"*\" ]] || [[ "$PUBLIC_ORIGIN_VALUE" == \'*\' ]]; then
      PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE:1:${#PUBLIC_ORIGIN_VALUE}-2}"
    fi
  fi
  PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE:-http://localhost:2086}"
  ( cd "$REPO" && PUBLIC_ORIGIN="$PUBLIC_ORIGIN_VALUE" npm run build -w @orbit/web >/dev/null )
fi

if outcome_release_dag_db_enabled; then
  echo '==> work-overview: clone the bound migrated PostgreSQL template'
  outcome_release_dag_bind_database
  PG_CONTAINER="$CONTAINER"
  PG_USER="$ADMIN"
  PG_PASSWORD="$PASSWORD"
  PG_DATABASE="$DATABASE"
  PG_PORT="$PORT"
  PG_URL="$URL"
  PG_SYSTEM_IDENTIFIER="$SYSTEM_ID"
else
  echo '==> work-overview: provision isolated PostgreSQL 16'
  docker run -d --name "$PG_CONTAINER" --tmpfs /var/lib/postgresql/data:rw,size=1g \
    -e "POSTGRES_USER=$PG_USER" -e "POSTGRES_PASSWORD=$PG_PASSWORD" \
    -e "POSTGRES_DB=$PG_DATABASE" -p 127.0.0.1::5432 "$PG_IMAGE" >/dev/null
  PG_STARTED=1
  PG_READY=0
  for work_overview_try in $(seq 1 45); do
    if docker exec -e "PGPASSWORD=$PG_PASSWORD" "$PG_CONTAINER" \
      psql -h 127.0.0.1 -U "$PG_USER" -d "$PG_DATABASE" -tAc 'SELECT 1' >/dev/null 2>&1; then
      PG_READY=1
      break
    fi
    sleep 1
  done
  [ "$PG_READY" = "1" ] || { echo '!! disposable PostgreSQL did not become ready' >&2; exit 1; }
  PG_PORT_LINE="$(docker port "$PG_CONTAINER" 5432/tcp)"
  PG_PORT="${PG_PORT_LINE##*:}"
  PG_URL="postgresql://$PG_USER:$PG_PASSWORD@127.0.0.1:$PG_PORT/$PG_DATABASE"
  PG_SYSTEM_IDENTIFIER="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
  echo '==> work-overview: migrate disposable database'
  ( cd "$API" && DATABASE_URL="$PG_URL" node node_modules/prisma/build/index.js \
    migrate deploy --schema prisma/schema.prisma >/dev/null )
  MIGRATION_COUNT="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
  LAST_MIGRATION="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
    'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1' \
    | tr -d '[:space:]')"
fi
REPOSITORY_MIGRATIONS="$(find "$API/prisma/migrations" -mindepth 1 -maxdepth 1 -type d \
  -printf '%f\n' | LC_ALL=C sort)"
DATABASE_MIGRATIONS="$(docker exec "$PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DATABASE" -tAc \
  'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name')"
REPOSITORY_MIGRATION_COUNT="$(find "$API/prisma/migrations" -mindepth 1 -maxdepth 1 -type d \
  -printf '.\n' | wc -l | tr -d '[:space:]')"
REPOSITORY_LAST_MIGRATION="$(printf '%s\n' "$REPOSITORY_MIGRATIONS" | tail -n 1)"
[ "$DATABASE_MIGRATIONS" = "$REPOSITORY_MIGRATIONS" ] || {
  echo '!! database migration set differs from the repository migration set' >&2
  diff -u <(printf '%s\n' "$REPOSITORY_MIGRATIONS") \
    <(printf '%s\n' "$DATABASE_MIGRATIONS") >&2 || true
  exit 1
}
[ "$MIGRATION_COUNT" = "$REPOSITORY_MIGRATION_COUNT" ] \
  && [ "$LAST_MIGRATION" = "$REPOSITORY_LAST_MIGRATION" ] || {
  echo "!! migration frontier is $LAST_MIGRATION ($MIGRATION_COUNT), repository expects $REPOSITORY_LAST_MIGRATION ($REPOSITORY_MIGRATION_COUNT)" >&2
  exit 1
}

echo '==> work-overview: run canonical PostgreSQL matrix'
set +e
WORK_OVERVIEW_PG_URL="$PG_URL" \
COORDINATOR_PG_EXPECTED_DATABASE="$PG_DATABASE" \
COORDINATOR_PG_EXPECTED_USER="$PG_USER" \
COORDINATOR_PG_EXPECTED_SYSTEM_IDENTIFIER="$PG_SYSTEM_IDENTIFIER" \
COORDINATOR_FIXTURE_DISPOSABLE=true \
timeout -k 10 180 node --test --test-concurrency=1 --test-reporter=tap \
  "$API/build/projects/project-work-overview-readiness.pg.spec.js" 2>&1 | tee "$PG_TAP"
PG_TEST_RC=${PIPESTATUS[0]}
set -e
[ "$PG_TEST_RC" = "0" ] || { echo "!! PostgreSQL matrix failed rc=$PG_TEST_RC" >&2; exit "$PG_TEST_RC"; }

echo '==> work-overview: run Web/mobile canonical-state assertions'
set +e
WORK_OVERVIEW_PHONE_HTML="$PHONE_HTML" \
WORK_OVERVIEW_DOM_EVIDENCE="$DOM_EVIDENCE" \
"$REPO/node_modules/.bin/vitest" run --root "$WEB" --maxWorkers=1 --reporter=tap \
  src/components/WorkOverviewReadiness.acceptance.test.tsx 2>&1 | tee "$WEB_TAP"
WEB_TEST_RC=${PIPESTATUS[0]}
set -e
[ "$WEB_TEST_RC" = "0" ] || { echo "!! Web matrix failed rc=$WEB_TEST_RC" >&2; exit "$WEB_TEST_RC"; }

echo '==> work-overview: capture 390x844 phone screenshot from real rendered components'
chromium --headless --no-sandbox --disable-gpu --hide-scrollbars \
  --window-size=390,844 --force-device-scale-factor=1 \
  --screenshot="$SCREENSHOT" "file://$PHONE_HTML" >/dev/null 2>&1

echo '==> work-overview: remove writable fixture before deployment evidence'
if outcome_release_dag_db_enabled; then
  outcome_release_dag_drop_database
else
  docker rm -fv "$PG_CONTAINER" >/dev/null
  PG_STARTED=0
  docker inspect "$PG_CONTAINER" >/dev/null 2>&1 && {
    echo '!! disposable PostgreSQL survived cleanup' >&2
    exit 1
  }
fi

WEB_ARTIFACT_DIGEST="$(
  cd "$WEB/dist"
  find . -type f ! -path './dl/*' ! -name 'install.sh' -print | LC_ALL=C sort \
    | while IFS= read -r work_overview_artifact; do sha256sum "$work_overview_artifact"; done \
    | sha256sum | cut -d' ' -f1
)"

if [ "$EVIDENCE_PHASE" = PREDEPLOY_EVALUATION ]; then
  echo '==> work-overview: verify exact candidate Web artifact; defer deployment-only evidence'
  for work_overview_label in 'Awaiting verification' 'Verification failed' 'Missing verifier'; do
    grep -R -F -q "$work_overview_label" "$WEB/dist/assets" || {
      echo "!! candidate Web assets omit $work_overview_label" >&2
      exit 1
    }
  done
  DEPLOYED_WEB_ARTIFACT_DIGEST='DEFERRED'
  API_IMAGE_ID='DEFERRED'
  WEB_IMAGE_ID='DEFERRED'
  API_CREATED_AT='DEFERRED'
  WEB_CREATED_AT='DEFERRED'
  node - "$LIVE_EVIDENCE" "${OUTCOME_RELEASE_DAG_DEPLOYMENT_TASK_ID:?}" <<'NODE'
const fs = require('node:fs');
const [output, taskId] = process.argv.slice(2);
fs.writeFileSync(output, `${JSON.stringify({
  state: 'DEFERRED_TO_BOUND_TASK',
  taskId,
  readOnly: true,
  noTaskWasStarted: true,
}, null, 2)}\n`);
NODE
else
  echo '==> work-overview: verify deployed API/Web read-only'
  for work_overview_service in orbit-apiserver orbit-web; do
    [ "$(docker inspect "$work_overview_service" --format '{{.State.Health.Status}}')" = 'healthy' ] || {
      echo "!! $work_overview_service is not healthy" >&2
      exit 1
    }
  done
  docker exec orbit-web wget -qO- http://127.0.0.1/ >/dev/null
  for work_overview_label in 'Awaiting verification' 'Verification failed' 'Missing verifier'; do
    docker exec orbit-web grep -R -F -q "$work_overview_label" /usr/share/nginx/html/assets || {
      echo "!! deployed Web assets omit $work_overview_label" >&2
      exit 1
    }
  done

  # Hash the exact target artifact manifest inside the container. The nginx base contributes its
  # own 50x.html, which is deployment chrome rather than a Vite output.
  DEPLOYED_WEB_ARTIFACT_DIGEST="$(
    cd "$WEB/dist"
    find . -type f ! -path './dl/*' ! -name 'install.sh' -print | LC_ALL=C sort \
      | while IFS= read -r work_overview_artifact; do
          work_overview_deployed_hash="$(docker exec orbit-web sha256sum \
            "/usr/share/nginx/html/$work_overview_artifact" | cut -d' ' -f1)"
          [[ "$work_overview_deployed_hash" =~ ^[0-9a-f]{64}$ ]] || exit 1
          printf '%s  %s\n' "$work_overview_deployed_hash" "$work_overview_artifact"
        done \
      | sha256sum | cut -d' ' -f1
  )"
  [ "$WEB_ARTIFACT_DIGEST" = "$DEPLOYED_WEB_ARTIFACT_DIGEST" ] || {
    echo "!! Web artifact mismatch local=$WEB_ARTIFACT_DIGEST deployed=$DEPLOYED_WEB_ARTIFACT_DIGEST" >&2
    exit 1
  }

  docker exec \
    -e WORK_OVERVIEW_PROJECT_PUBLIC_ID=34EVnSK4xSBvXox6Za9AA \
    -e WORK_OVERVIEW_TASK_PUBLIC_ID=34EVtIlOD1lRdPL4c5j7E \
    orbit-apiserver node src/apiserver/dist/projects/work-overview-live-readonly.cli.js \
    | tee "$LIVE_EVIDENCE"
  API_IMAGE_ID="$(docker inspect orbit-apiserver --format '{{.Image}}')"
  WEB_IMAGE_ID="$(docker inspect orbit-web --format '{{.Image}}')"
  API_CREATED_AT="$(docker inspect orbit-apiserver --format '{{.Created}}')"
  WEB_CREATED_AT="$(docker inspect orbit-web --format '{{.Created}}')"
fi

REPOSITORY="$(git -C "$REPO" config --get remote.origin.url)"
SOURCE_ARCHIVE_DIGEST="$(git -C "$REPO" archive "$TARGET_SHA" | sha256sum | cut -d' ' -f1)"
echo '==> work-overview: write machine-bound zero-skip manifest'
WORK_OVERVIEW_REPO="$REPO" \
WORK_OVERVIEW_BASE_SHA="$BASE_SHA" \
WORK_OVERVIEW_TARGET_SHA="$TARGET_SHA" \
WORK_OVERVIEW_MAIN_SHA="$MAIN_SHA" \
WORK_OVERVIEW_REPOSITORY="$REPOSITORY" \
WORK_OVERVIEW_SOURCE_ARCHIVE_DIGEST="$SOURCE_ARCHIVE_DIGEST" \
WORK_OVERVIEW_WEB_ARTIFACT_DIGEST="$WEB_ARTIFACT_DIGEST" \
WORK_OVERVIEW_DEPLOYED_WEB_ARTIFACT_DIGEST="$DEPLOYED_WEB_ARTIFACT_DIGEST" \
WORK_OVERVIEW_PROVIDER="$PROVIDER" \
WORK_OVERVIEW_EVIDENCE_PHASE="$EVIDENCE_PHASE" \
WORK_OVERVIEW_DEPLOYMENT_TASK_ID="${OUTCOME_RELEASE_DAG_DEPLOYMENT_TASK_ID:-NONE}" \
WORK_OVERVIEW_STARTED_AT="$STARTED_AT" \
WORK_OVERVIEW_PG_SYSTEM_IDENTIFIER="$PG_SYSTEM_IDENTIFIER" \
WORK_OVERVIEW_MIGRATION_COUNT="$MIGRATION_COUNT" \
WORK_OVERVIEW_LAST_MIGRATION="$LAST_MIGRATION" \
WORK_OVERVIEW_API_IMAGE_ID="$API_IMAGE_ID" \
WORK_OVERVIEW_WEB_IMAGE_ID="$WEB_IMAGE_ID" \
WORK_OVERVIEW_API_CREATED_AT="$API_CREATED_AT" \
WORK_OVERVIEW_WEB_CREATED_AT="$WEB_CREATED_AT" \
node "$REPO/scripts/outcome-reconciler-work-overview-readiness-manifest.mjs" \
  "$PG_TAP" "$WEB_TAP" "$DOM_EVIDENCE" "$SCREENSHOT" "$LIVE_EVIDENCE" "$MANIFEST"

echo "✓ Work overview readiness accepted: tests=22 skip=0 target=$TARGET_SHA phase=$EVIDENCE_PHASE"
echo "  manifest=$MANIFEST"
