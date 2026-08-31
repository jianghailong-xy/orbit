#!/usr/bin/env bash
# Restart the one PostgreSQL server a full-api case was handed, and hand it back only once that
# server is really answering as the case's own role again.
#
# The caller is `COORDINATOR_PG_RESTART_COMMAND` for the specs that assert what survives a real
# server restart. Their case budget is 180s, so the wait here is bounded well inside it: long
# enough that a server coming back on a loaded host is not called dead, short enough that a server
# that never comes back is reported HERE, with evidence, instead of as an opaque case timeout.
set -euo pipefail

[ "$#" = 4 ] || { echo 'usage: restart-postgres CONTAINER USER PASSWORD DATABASE' >&2; exit 2; }
CONTAINER="$1"
ADMIN="$2"
PASSWORD="$3"
DATABASE="$4"

READY_TIMEOUT_SECONDS="${OUTCOME_PG_RESTART_READY_TIMEOUT_SECONDS:-120}"
[[ "$READY_TIMEOUT_SECONDS" =~ ^[1-9][0-9]*$ ]] || {
  echo 'OUTCOME_PG_RESTART_READY_TIMEOUT_SECONDS must be a positive whole number of seconds' >&2
  exit 2
}
MAX_BACKOFF_SECONDS=5
LAST_PROBE_ERROR=''

# Everything a reader needs to tell "slow" from "never coming back" without re-running anything.
diagnose() {
  local waited="$1" attempts="$2" reason="$3"
  {
    echo "PostgreSQL container $CONTAINER did not become ready: $reason"
    echo "  waited ${waited}s of a ${READY_TIMEOUT_SECONDS}s budget over ${attempts} probe(s)"
    echo "  container: $(docker inspect -f 'status={{.State.Status}} running={{.State.Running}} restarting={{.State.Restarting}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$CONTAINER" 2>&1 || true)"
    echo "  last probe: ${LAST_PROBE_ERROR:-<none>}"
    echo '  docker logs --tail 20:'
    docker logs --tail 20 "$CONTAINER" 2>&1 | sed 's/^/    /' || true
  } >&2
}

if ! RESTART_ERROR="$(docker restart "$CONTAINER" 2>&1 >/dev/null)"; then
  echo "PostgreSQL container $CONTAINER could not be restarted: $RESTART_ERROR" >&2
  exit 1
fi

STARTED_AT="$SECONDS"
ATTEMPTS=0
BACKOFF=1
while :; do
  # The container running is a precondition, not the property the caller needs: a server that has
  # already exited is answered now rather than waited out, and the readiness itself is still a real
  # connection below.
  if ! STATE="$(docker inspect -f '{{.State.Running}} {{.State.Restarting}}' "$CONTAINER" 2>&1)"; then
    LAST_PROBE_ERROR="docker inspect failed: $STATE"
    diagnose "$(( SECONDS - STARTED_AT ))" "$ATTEMPTS" 'the container could not be inspected'
    exit 1
  fi
  if [ "$STATE" = 'false false' ]; then
    diagnose "$(( SECONDS - STARTED_AT ))" "$ATTEMPTS" 'the container is no longer running'
    exit 1
  fi
  ATTEMPTS=$(( ATTEMPTS + 1 ))
  # Over TCP as the case's own role: initdb runs a temporary server on the unix socket only, and
  # probing there reports ready seconds before the real server exists.
  if LAST_PROBE_ERROR="$(docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d "$DATABASE" -tAc 'SELECT 1' 2>&1 >/dev/null)"; then
    exit 0
  fi
  ELAPSED=$(( SECONDS - STARTED_AT ))
  if [ "$ELAPSED" -ge "$READY_TIMEOUT_SECONDS" ]; then
    diagnose "$ELAPSED" "$ATTEMPTS" 'it never accepted a connection'
    exit 1
  fi
  # Rising, not a fixed second: the host running this is also running the rest of the matrix.
  sleep "$BACKOFF"
  [ "$BACKOFF" -ge "$MAX_BACKOFF_SECONDS" ] || BACKOFF=$(( BACKOFF + 1 ))
done
