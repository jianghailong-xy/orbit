#!/usr/bin/env bash
# Bring up the walk's database: a throwaway postgres:16 (tmpfs, 127.0.0.1:<pg port>, container p3walk-pg-<pg port>),
# write <walk>/env (mode 600: DATABASE_URL, fresh random JWT_SECRET and PROVIDER_SECRET_KEY, PORT, PUBLIC_ORIGIN), and
# run `prisma migrate deploy` from the tip's apiserver.
# usage: up.sh <tip checkout> <walk dir> <pg port> <api port> <web port>
set -euo pipefail
tip=$1 walk=$2 pgport=$3 apiport=$4 webport=$5
name=p3walk-pg-$pgport
mkdir -p "$walk"
for p in "$pgport" "$apiport" "$webport"; do
  if ss -ltn | grep -q ":$p "; then echo "port $p is taken"; exit 1; fi
done
if docker ps -a --format '{{.Names}}' | grep -qx "$name"; then echo "container $name exists"; exit 1; fi
docker run -d --name "$name" --tmpfs /var/lib/postgresql/data:rw,size=2g \
  -e POSTGRES_PASSWORD=p3walk -e POSTGRES_USER=orbit -e POSTGRES_DB=orbit \
  -p "127.0.0.1:$pgport:5432" postgres:16 > "$walk/pg.cid"
echo "$name" > "$walk/pg.name"
for _ in $(seq 1 60); do
  # pg_isready answers during the image's init restart too, so ask for a real query.
  if docker exec "$name" psql -U orbit -d orbit -qAt -c 'SELECT 1' >/dev/null 2>&1; then break; fi
  sleep 1
done
(umask 077; cat > "$walk/env" <<ENV
export DATABASE_URL=postgresql://orbit:p3walk@127.0.0.1:$pgport/orbit
export JWT_SECRET=$(openssl rand -hex 32)
export PROVIDER_SECRET_KEY=$(openssl rand -hex 32)
export PORT=$apiport
export PUBLIC_ORIGIN=http://127.0.0.1:$webport
ENV
)
cd "$tip/src/apiserver"
. "$walk/env"
for attempt in 1 2 3; do
  if npx prisma migrate deploy > "$walk/migrate.log" 2>&1; then echo "migrated ($name)"; exit 0; fi
  sleep 3
done
tail -20 "$walk/migrate.log"; exit 1
