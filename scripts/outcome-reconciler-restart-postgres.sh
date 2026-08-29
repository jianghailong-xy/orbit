#!/usr/bin/env bash
set -euo pipefail

[ "$#" = 4 ] || { echo 'usage: restart-postgres CONTAINER USER PASSWORD DATABASE' >&2; exit 2; }
CONTAINER="$1"
ADMIN="$2"
PASSWORD="$3"
DATABASE="$4"

docker restart "$CONTAINER" >/dev/null
for _ in $(seq 1 60); do
  if docker exec -e "PGPASSWORD=$PASSWORD" "$CONTAINER" \
    psql -h 127.0.0.1 -U "$ADMIN" -d "$DATABASE" -tAc 'SELECT 1' >/dev/null 2>&1; then
    exit 0
  fi
  sleep 1
done
echo "PostgreSQL container $CONTAINER did not become ready" >&2
exit 1
