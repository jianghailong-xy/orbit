#!/usr/bin/env bash
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API="$REPO/src/apiserver"
ACTION="${1:-}"
OUTPUT="${2:-}"

require_binding() {
  : "${OUTCOME_RELEASE_DAG_TARGET_SHA:?}"
  : "${OUTCOME_RELEASE_DAG_BINDING_DIGEST:?}"
  : "${OUTCOME_RELEASE_DAG_RUN_ROOT:?}"
  [ "$(git -C "$REPO" rev-parse HEAD)" = "$OUTCOME_RELEASE_DAG_TARGET_SHA" ] || {
    echo 'release DAG preparation is not on the bound target' >&2
    exit 2
  }
}

case "$ACTION" in
  dependencies)
    require_binding
    [ -n "$OUTPUT" ] || { echo 'usage: release-dag-prepare dependencies OUTPUT' >&2; exit 2; }
    INSTALLED_ROOT='/root/orbit'
    [ -d "$INSTALLED_ROOT/node_modules" ] || {
      echo 'installed dependency checkout is unavailable' >&2
      exit 1
    }
    [ -d "$INSTALLED_ROOT/src/apiserver/node_modules" ] || {
      echo 'installed API dependencies are unavailable' >&2
      exit 1
    }
    [ -d "$INSTALLED_ROOT/src/web/node_modules" ] || {
      echo 'installed Web dependencies are unavailable' >&2
      exit 1
    }

    safe_link() {
      local source="$1"
      local destination="$2"
      if [ -L "$destination" ]; then
        [ "$(readlink -f "$destination")" = "$(readlink -f "$source")" ] || {
          echo "conflicting dependency link: $destination" >&2
          return 2
        }
      elif [ -e "$destination" ]; then
        echo "refusing to replace dependency path: $destination" >&2
        return 2
      else
        ln -s "$source" "$destination"
      fi
    }

    materialize_dependency_root() {
      local destination="$1"
      local expected="$2"
      if [ -L "$destination" ]; then
        [ "$(readlink -f "$destination")" = "$(readlink -f "$expected")" ] || {
          echo "refusing foreign dependency root: $destination" >&2
          return 2
        }
        unlink "$destination"
      elif [ -e "$destination" ] && [ ! -d "$destination" ]; then
        echo "refusing non-directory dependency root: $destination" >&2
        return 2
      fi
      mkdir -p "$destination"
    }

    echo '==> release-dag prepare-dependencies: create worktree-local immutable links'
    materialize_dependency_root "$REPO/node_modules" "$INSTALLED_ROOT/node_modules"
    materialize_dependency_root "$API/node_modules" "$INSTALLED_ROOT/src/apiserver/node_modules"
    materialize_dependency_root "$REPO/src/web/node_modules" "$INSTALLED_ROOT/src/web/node_modules"
    mkdir -p "$REPO/node_modules/@orbit" "$REPO/node_modules/.cache" \
      "$API/node_modules/.cache" "$REPO/src/shared/node_modules/.vite" \
      "$REPO/src/web/node_modules/.vite" "$REPO/src/web/node_modules/@orbit"
    while IFS= read -r -d '' DEPENDENCY; do
      BASE="${DEPENDENCY##*/}"
      case "$BASE" in @orbit|.cache|.vite|.vite-temp) continue ;; esac
      safe_link "$DEPENDENCY" "$REPO/node_modules/$BASE"
    done < <(find "$INSTALLED_ROOT/node_modules" -mindepth 1 -maxdepth 1 -print0)
    safe_link "$REPO/src/shared" "$REPO/node_modules/@orbit/shared"
    safe_link "$API" "$REPO/node_modules/@orbit/apiserver"
    safe_link "$REPO/src/web" "$REPO/node_modules/@orbit/web"

    for BASE in .bin prisma typescript; do
      safe_link "$INSTALLED_ROOT/src/apiserver/node_modules/$BASE" "$API/node_modules/$BASE"
    done
    for BASE in @prisma .prisma; do
      if [ ! -e "$API/node_modules/$BASE" ]; then
        cp -a --reflink=auto "$INSTALLED_ROOT/src/apiserver/node_modules/$BASE" \
          "$API/node_modules/$BASE"
      fi
    done
    while IFS= read -r -d '' DEPENDENCY; do
      BASE="${DEPENDENCY##*/}"
      case "$BASE" in @orbit|.cache|.vite|.vite-temp) continue ;; esac
      safe_link "$DEPENDENCY" "$REPO/src/web/node_modules/$BASE"
    done < <(find "$INSTALLED_ROOT/src/web/node_modules" -mindepth 1 -maxdepth 1 -print0)
    safe_link "$REPO/src/shared" "$REPO/src/web/node_modules/@orbit/shared"

    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" dependency-context "$OUTPUT" \
      node_modules/.bin node_modules/@orbit/shared \
      src/apiserver/node_modules/.bin src/apiserver/node_modules/@prisma \
      src/apiserver/node_modules/.prisma src/shared/node_modules/.vite \
      src/web/node_modules/.bin \
      src/web/node_modules/@orbit/shared
    ;;

  prisma)
    require_binding
    [ -n "$OUTPUT" ] || { echo 'usage: release-dag-prepare prisma OUTPUT' >&2; exit 2; }
    echo '==> release-dag prepare-prisma: generate the worktree-private Prisma client once'
    ( cd "$REPO" && npm run prisma:generate -w @orbit/apiserver >/dev/null )
    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" prisma-context "$OUTPUT"
    ;;

  build)
    require_binding
    [ -n "$OUTPUT" ] || { echo 'usage: release-dag-prepare build OUTPUT' >&2; exit 2; }
    mkdir -p "$REPO/build" "$API/build/node_modules/@orbit" "$API/src/node_modules/@orbit"

    echo '==> release-dag prepare-build: compile Shared, API, every API spec and Web once'
    ( cd "$REPO" && npm run build -w @orbit/shared >/dev/null )
    ( cd "$REPO" && npm run build -w @orbit/apiserver >/dev/null )
    ( cd "$API" && ./node_modules/.bin/tsc --build --clean tsconfig.test.json )
    ( cd "$API" && ./node_modules/.bin/tsc -p tsconfig.test.json )
    PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN:-}"
    if [ -z "$PUBLIC_ORIGIN_VALUE" ] && [ -f /root/orbit/.env ]; then
      PUBLIC_ORIGIN_VALUE="$(sed -n 's/^PUBLIC_ORIGIN=//p' /root/orbit/.env | tail -n 1)"
      PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE%$'\r'}"
      if [[ "$PUBLIC_ORIGIN_VALUE" == \"*\" ]] || [[ "$PUBLIC_ORIGIN_VALUE" == \'*\' ]]; then
        PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE:1:${#PUBLIC_ORIGIN_VALUE}-2}"
      fi
    fi
    PUBLIC_ORIGIN_VALUE="${PUBLIC_ORIGIN_VALUE:-http://localhost:2086}"
    ( cd "$REPO" && PUBLIC_ORIGIN="$PUBLIC_ORIGIN_VALUE" npm run build -w @orbit/web >/dev/null )

    ln -sfn "$REPO/src/shared" "$API/build/node_modules/@orbit/shared"
    if [ -e "$API/src/node_modules/@orbit/shared" ] || [ -L "$API/src/node_modules/@orbit/shared" ]; then
      [ "$(readlink -f "$API/src/node_modules/@orbit/shared")" = "$(readlink -f "$REPO/src/shared")" ] || {
        echo 'API source has a conflicting @orbit/shared resolution' >&2
        exit 2
      }
    else
      ln -s "$REPO/src/shared" "$API/src/node_modules/@orbit/shared"
    fi

    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" build-context "$OUTPUT" \
      package.json package-lock.json src/apiserver/prisma/schema.prisma \
      src/apiserver/tsconfig.test.json src/shared/tsconfig.json \
      src/web/tsconfig.json
    ;;

  postgres)
    require_binding
    [ -n "$OUTPUT" ] || { echo 'usage: release-dag-prepare postgres OUTPUT' >&2; exit 2; }
    command -v docker >/dev/null || { echo 'docker is required' >&2; exit 1; }
    docker info >/dev/null 2>&1 || { echo 'docker daemon is unavailable' >&2; exit 1; }
    CONTAINER="orbit-release-dag-pg-${OUTCOME_RELEASE_DAG_BINDING_DIGEST:0:12}"
    ADMIN='ord_admin'
    PASSWORD='ord_disposable_password'
    CURRENT_TEMPLATE='ord_template_current'
    BEFORE_OWNER_TEMPLATE='ord_template_before_owner_routing'
    IMAGE="${OUTCOME_RELEASE_DAG_PG_IMAGE:-postgres:16-alpine}"
    STAGE="$OUTCOME_RELEASE_DAG_RUN_ROOT/prisma-before-owner-routing"

    while IFS= read -r STALE_CONTAINER; do
      [ -n "$STALE_CONTAINER" ] || continue
      STALE_BINDING="$(docker inspect -f '{{ index .Config.Labels "orbit.release-dag.binding" }}' \
        "$STALE_CONTAINER")"
      if [ "$STALE_BINDING" != "$OUTCOME_RELEASE_DAG_BINDING_DIGEST" ]; then
        docker rm -fv "$STALE_CONTAINER" >/dev/null
      fi
    done < <(docker ps -aq --filter 'label=orbit.release-dag.managed=true')

    if docker inspect "$CONTAINER" >/dev/null 2>&1; then
      OBSERVED_BINDING="$(docker inspect -f '{{ index .Config.Labels "orbit.release-dag.binding" }}' "$CONTAINER")"
      [ "$OBSERVED_BINDING" = "$OUTCOME_RELEASE_DAG_BINDING_DIGEST" ] || {
        echo "refusing foreign PostgreSQL fixture $CONTAINER" >&2
        exit 2
      }
      docker rm -fv "$CONTAINER" >/dev/null
    fi

    echo '==> release-dag prepare-postgres: provision one bounded PostgreSQL 16 server'
    docker run -d --name "$CONTAINER" \
      --label 'orbit.release-dag.managed=true' \
      --label "orbit.release-dag.binding=$OUTCOME_RELEASE_DAG_BINDING_DIGEST" \
      --cpus 2 --memory 3072m --memory-swap 3072m --pids-limit 512 \
      --tmpfs /var/lib/postgresql/data:rw,size=3g \
      -e "POSTGRES_USER=$ADMIN" -e "POSTGRES_PASSWORD=$PASSWORD" -e POSTGRES_DB=postgres \
      -p 127.0.0.1::5432 "$IMAGE" >/dev/null
    OBSERVED_IMAGE_ID="$(docker inspect -f '{{.Image}}' "$CONTAINER")"
    [ "$OBSERVED_IMAGE_ID" = "${OUTCOME_RELEASE_DAG_POSTGRES_IMAGE_ID:?}" ] || {
      echo "PostgreSQL image changed after admission: $OBSERVED_IMAGE_ID" >&2
      exit 1
    }
    READY=0
    for _ in $(seq 1 90); do
      if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
        psql -h 127.0.0.1 -U "$ADMIN" -d postgres -tAc 'SELECT 1' >/dev/null 2>&1; then
        READY=1
        break
      fi
      sleep 1
    done
    [ "$READY" = 1 ] || { echo 'release DAG PostgreSQL did not become ready' >&2; exit 1; }
    PORT_LINE="$(docker port "$CONTAINER" 5432/tcp)"
    PORT="${PORT_LINE##*:}"
    SYSTEM_ID="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
      'SELECT system_identifier FROM pg_control_system()' | tr -d '[:space:]')"
    VERSION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -tAc \
      'SHOW server_version' | tr -d '[:space:]')"
    [ "$VERSION" = '16.14' ] || { echo "unexpected PostgreSQL version: $VERSION" >&2; exit 1; }

    REPOSITORY_MIGRATIONS="$(find "$API/prisma/migrations" -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d '[:space:]')"
    echo '==> release-dag prepare-postgres: apply migrations through 0209 exactly once'
    docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE $BEFORE_OWNER_TEMPLATE" >/dev/null
    BEFORE_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$BEFORE_OWNER_TEMPLATE"
    rm -rf -- "$STAGE"
    mkdir -p "$STAGE"
    cp -R "$API/prisma" "$STAGE/prisma"
    cp "$API/prisma.config.ts" "$STAGE/prisma.config.ts"
    rm -rf -- "$STAGE/prisma/migrations/0210_owner_ratification_inbox_eligibility"
    ( cd "$STAGE" && DATABASE_URL="$BEFORE_URL" "$API/node_modules/.bin/prisma" \
      migrate deploy --config prisma.config.ts >/dev/null )
    rm -rf -- "$STAGE"
    BEFORE_MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$BEFORE_OWNER_TEMPLATE" -tAc \
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
    [ "$BEFORE_MIGRATIONS" -eq $((REPOSITORY_MIGRATIONS - 1)) ] || {
      echo "pre-0210 migration mismatch applied=$BEFORE_MIGRATIONS repository=$REPOSITORY_MIGRATIONS" >&2
      exit 1
    }

    echo '==> release-dag prepare-postgres: clone 0209 and apply only the current delta'
    docker exec "$CONTAINER" psql -U "$ADMIN" -d postgres -v ON_ERROR_STOP=1 \
      -c "CREATE DATABASE $CURRENT_TEMPLATE TEMPLATE $BEFORE_OWNER_TEMPLATE" >/dev/null
    CURRENT_URL="postgresql://$ADMIN:$PASSWORD@127.0.0.1:$PORT/$CURRENT_TEMPLATE"
    ( cd "$API" && DATABASE_URL="$CURRENT_URL" node node_modules/prisma/build/index.js \
      migrate deploy --schema prisma/schema.prisma >/dev/null )
    MIGRATIONS="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$CURRENT_TEMPLATE" -tAc \
      'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL' | tr -d '[:space:]')"
    LAST_MIGRATION="$(docker exec "$CONTAINER" psql -U "$ADMIN" -d "$CURRENT_TEMPLATE" -tAc \
      'SELECT migration_name FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY migration_name DESC LIMIT 1' \
      | tr -d '[:space:]')"
    [ "$MIGRATIONS" = "$REPOSITORY_MIGRATIONS" ] || {
      echo "migration frontier mismatch applied=$MIGRATIONS repository=$REPOSITORY_MIGRATIONS" >&2
      exit 1
    }

    node "$REPO/scripts/outcome-reconciler-release-dag-step.mjs" postgres-context \
      "$OUTPUT" "$CONTAINER" "$ADMIN" "$PASSWORD" '127.0.0.1' "$PORT" \
      "$SYSTEM_ID" "$VERSION" "$MIGRATIONS" "$LAST_MIGRATION" \
      "$CURRENT_TEMPLATE" "$BEFORE_OWNER_TEMPLATE" "$OBSERVED_IMAGE_ID"
    ;;

  cleanup-postgres)
    [ -n "$OUTPUT" ] && [ -f "$OUTPUT" ] || exit 0
    CONTAINER="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.container)' "$OUTPUT")"
    BINDING="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.bindingDigest)' "$OUTPUT")"
    if docker inspect "$CONTAINER" >/dev/null 2>&1; then
      OBSERVED_BINDING="$(docker inspect -f '{{ index .Config.Labels "orbit.release-dag.binding" }}' "$CONTAINER")"
      [ "$OBSERVED_BINDING" = "$BINDING" ] || {
        echo "refusing to remove foreign PostgreSQL fixture $CONTAINER" >&2
        exit 2
      }
      docker rm -fv "$CONTAINER" >/dev/null
    fi
    ;;

  *)
    echo 'usage: release-dag-prepare.sh dependencies|prisma|build|postgres|cleanup-postgres OUTPUT' >&2
    exit 2
    ;;
esac
