#!/usr/bin/env bash
# Shared helpers for legacy acceptance entrypoints when they execute as Release DAG nodes.
# Standalone invocations never enter these branches and retain their disposable-container setup.

outcome_release_dag_db_enabled() {
  [ -n "${OUTCOME_RELEASE_DAG_PG_CONTEXT:-}" ]
}

outcome_release_dag_assert_build() {
  [ "${OUTCOME_RELEASE_DAG_PREPARED_BUILD:-0}" = 1 ] || return 1
  [ -s "${OUTCOME_RELEASE_DAG_BUILD_CONTEXT:-}" ] || {
    echo '!! bound Release DAG build context is missing' >&2
    return 2
  }
  local observed_target observed_binding
  observed_target="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.targetSha)' \
    "$OUTCOME_RELEASE_DAG_BUILD_CONTEXT")"
  observed_binding="$(node -e 'const v=require(process.argv[1]);process.stdout.write(v.bindingDigest)' \
    "$OUTCOME_RELEASE_DAG_BUILD_CONTEXT")"
  [ "$observed_target" = "${OUTCOME_RELEASE_DAG_TARGET_SHA:-}" ] || {
    echo '!! stale Release DAG build target' >&2
    return 2
  }
  [ "$observed_binding" = "${OUTCOME_RELEASE_DAG_BINDING_DIGEST:-}" ] || {
    echo '!! stale Release DAG build binding' >&2
    return 2
  }
  node - "$OUTCOME_RELEASE_DAG_BUILD_CONTEXT" "$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)" <<'NODE'
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const [contextPath, repo] = process.argv.slice(2);
const context = JSON.parse(fs.readFileSync(contextPath, 'utf8'));
if (!Array.isArray(context.outputs) || context.outputs.length === 0) {
  throw new Error('Release DAG build context omitted compiled outputs');
}
for (const output of context.outputs) {
  const file = path.resolve(repo, output.path);
  const raw = fs.readFileSync(file);
  const digest = crypto.createHash('sha256').update(raw).digest('hex');
  if (raw.byteLength !== output.bytes || digest !== output.sha256) {
    throw new Error(`Release DAG compiled output changed: ${output.path}`);
  }
}
NODE
}

outcome_release_dag_bind_database() {
  outcome_release_dag_db_enabled || return 1
  : "${OUTCOME_RELEASE_DAG_PG_CONTAINER:?}"
  : "${OUTCOME_RELEASE_DAG_PG_ADMIN:?}"
  : "${OUTCOME_RELEASE_DAG_PG_PASSWORD:?}"
  : "${OUTCOME_RELEASE_DAG_PG_HOST:?}"
  : "${OUTCOME_RELEASE_DAG_PG_PORT:?}"
  : "${OUTCOME_RELEASE_DAG_PG_SYSTEM_ID:?}"
  : "${OUTCOME_RELEASE_DAG_PG_VERSION:?}"
  : "${OUTCOME_RELEASE_DAG_PG_MIGRATIONS:?}"
  : "${OUTCOME_RELEASE_DAG_PG_TEMPLATE:?}"
  : "${OUTCOME_RELEASE_DAG_DATABASE:?}"
  : "${OUTCOME_RELEASE_DAG_DATABASE_USER:?}"
  : "${OUTCOME_RELEASE_DAG_DATABASE_PREFIX:?}"
  : "${OUTCOME_RELEASE_DAG_ROLE_PREFIX:?}"
  : "${OUTCOME_RELEASE_DAG_DESTRUCTIVE_COORDINATOR_SPECS:?}"
  [[ "$OUTCOME_RELEASE_DAG_DATABASE" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || {
    echo '!! unsafe Release DAG database name' >&2
    return 2
  }
  [[ "$OUTCOME_RELEASE_DAG_DATABASE_USER" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || {
    echo '!! unsafe Release DAG database role' >&2
    return 2
  }
  [[ "$OUTCOME_RELEASE_DAG_DATABASE" == "${OUTCOME_RELEASE_DAG_DATABASE_PREFIX}_"* ]] || {
    echo '!! Release DAG database does not match its declared node prefix' >&2
    return 2
  }
  [[ "$OUTCOME_RELEASE_DAG_DATABASE_USER" == "${OUTCOME_RELEASE_DAG_ROLE_PREFIX}_"* ]] || {
    echo '!! Release DAG role does not match its declared node prefix' >&2
    return 2
  }
  if [ "$OUTCOME_RELEASE_DAG_DESTRUCTIVE_COORDINATOR_SPECS" = 1 ]; then
    [[ "$OUTCOME_RELEASE_DAG_DATABASE" =~ ^pcc[0-9a-z]*_ ]] || {
      echo '!! destructive coordinator specs require a dedicated pcc_* database' >&2
      return 2
    }
    [[ "$OUTCOME_RELEASE_DAG_DATABASE_USER" =~ ^pcc[0-9a-z]*_ ]] || {
      echo '!! destructive coordinator specs require a dedicated pcc_* role' >&2
      return 2
    }
  elif [ "$OUTCOME_RELEASE_DAG_DESTRUCTIVE_COORDINATOR_SPECS" != 0 ]; then
    echo '!! invalid destructive coordinator spec declaration' >&2
    return 2
  fi
  [[ "$OUTCOME_RELEASE_DAG_PG_TEMPLATE" =~ ^pccrd_template_[a-z0-9_]+$ ]] || {
    echo '!! unsafe Release DAG template name' >&2
    return 2
  }
  CONTAINER="$OUTCOME_RELEASE_DAG_PG_CONTAINER"
  PROVISIONER="$OUTCOME_RELEASE_DAG_PG_ADMIN"
  ADMIN="$OUTCOME_RELEASE_DAG_DATABASE_USER"
  PASSWORD="$OUTCOME_RELEASE_DAG_PG_PASSWORD"
  DATABASE="$OUTCOME_RELEASE_DAG_DATABASE"
  PORT="$OUTCOME_RELEASE_DAG_PG_PORT"
  PG_PORT="$PORT"
  PG_HOST="$OUTCOME_RELEASE_DAG_PG_HOST"
  SYSTEM_ID="$OUTCOME_RELEASE_DAG_PG_SYSTEM_ID"
  SYSTEM_IDENTIFIER="$SYSTEM_ID"
  PG_SYSTEM_IDENTIFIER="$SYSTEM_ID"
  PG_VERSION="$OUTCOME_RELEASE_DAG_PG_VERSION"
  MIGRATIONS="$OUTCOME_RELEASE_DAG_PG_MIGRATIONS"
  MIGRATION_COUNT="$MIGRATIONS"
  LAST_MIGRATION="${OUTCOME_RELEASE_DAG_PG_LAST_MIGRATION:-}"
  URL="postgresql://$ADMIN:$PASSWORD@$PG_HOST:$PG_PORT/$DATABASE"
  PG_URL="$URL"

  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DATABASE' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$DATABASE\"" >/dev/null
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP ROLE IF EXISTS \"$ADMIN\"" >/dev/null
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE \"$ADMIN\" LOGIN SUPERUSER PASSWORD '$PASSWORD'" >/dev/null
  OUTCOME_RELEASE_DAG_DB_BOUND=1
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$DATABASE\" WITH TEMPLATE \"$OUTCOME_RELEASE_DAG_PG_TEMPLATE\" OWNER \"$ADMIN\"" >/dev/null
  local observed_database observed_role observed_system
  IFS=$'\t' read -r observed_database observed_role observed_system < <(
    docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
      psql -h 127.0.0.1 -U "$ADMIN" -d "$DATABASE" -X -At -F $'\t' -v ON_ERROR_STOP=1 \
      -c "SELECT current_database(), current_user, system_identifier::text FROM pg_control_system()"
  )
  [ "$observed_database" = "$DATABASE" ] || return 2
  [ "$observed_role" = "$ADMIN" ] || return 2
  [ "$observed_system" = "$SYSTEM_ID" ] || return 2
  echo "==> release-dag PostgreSQL identity: database=$DATABASE role=$ADMIN binding=${OUTCOME_RELEASE_DAG_BINDING_DIGEST:0:12} attempt=${OUTCOME_RELEASE_DAG_ATTEMPT_TOKEN:-missing}"
  export CONTAINER PROVISIONER ADMIN PASSWORD DATABASE PORT PG_PORT PG_HOST SYSTEM_ID SYSTEM_IDENTIFIER
  export PG_SYSTEM_IDENTIFIER PG_VERSION MIGRATIONS MIGRATION_COUNT LAST_MIGRATION URL PG_URL
}

outcome_release_dag_drop_database() {
  [ "${OUTCOME_RELEASE_DAG_DB_BOUND:-0}" = 1 ] || return 0
  [ "${DATABASE:-}" = "${OUTCOME_RELEASE_DAG_DATABASE:-}" ] || return 2
  [ "${ADMIN:-}" = "${OUTCOME_RELEASE_DAG_DATABASE_USER:-}" ] || return 2
  [[ "$DATABASE" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || return 2
  [[ "$ADMIN" =~ ^[a-z][a-z0-9_]{1,62}$ ]] || return 2
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname='$DATABASE' AND pid <> pg_backend_pid()" \
    >/dev/null 2>&1 || true
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS \"$DATABASE\"" >/dev/null
  docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP ROLE IF EXISTS \"$ADMIN\"" >/dev/null
  local leftovers
  leftovers="$(docker exec "$CONTAINER" psql -U "$PROVISIONER" -d postgres -At -v ON_ERROR_STOP=1 \
    -c "SELECT (SELECT count(*) FROM pg_database WHERE datname='$DATABASE') + (SELECT count(*) FROM pg_roles WHERE rolname='$ADMIN')")"
  [ "$leftovers" = 0 ] || {
    echo '!! Release DAG database or role survived cleanup' >&2
    return 2
  }
  OUTCOME_RELEASE_DAG_DB_BOUND=0
}
