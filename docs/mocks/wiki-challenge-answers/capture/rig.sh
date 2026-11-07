#!/usr/bin/env bash
# Private stack for task 34tDf8rxHzhwoGyK6r0kj: postgres (tmpfs) on 127.0.0.1:5734, apiserver on :3734, gateway on :2734.
# usage: rig.sh db | api | gw [dist] | down
set -euo pipefail
WT=/root/.orbit/worktrees/1ff76a3e-e1d0-52b9-a611-9b0c45796a70
S=/mnt/data/tmp/34tDf8/stack
PG=rv34t-pg
DB=postgresql://orbit:orbit@127.0.0.1:5734/orbit
[ -f "$S/secrets.env" ] || {
  umask 077
  printf 'JWT_SECRET=%s\nPROVIDER_SECRET_KEY=%s\n' "$(openssl rand -hex 32)" "$(openssl rand -base64 32)" > "$S/secrets.env"
}
case "${1:-}" in
  db)
    docker rm -f "$PG" >/dev/null 2>&1 || true
    docker run -d --name "$PG" -p 127.0.0.1:5734:5432 --tmpfs /var/lib/postgresql/data \
      -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit -e POSTGRES_DB=orbit postgres:16-alpine >/dev/null
    for i in $(seq 1 60); do docker exec "$PG" pg_isready -U orbit >/dev/null 2>&1 && break; sleep 1; done
    sleep 2
    cd "$WT/src/apiserver" && DATABASE_URL=$DB npx prisma migrate deploy 2>&1 | tail -3
    ;;
  api)
    cd "$WT/src/apiserver"
    set -a; . "$S/secrets.env"; set +a
    exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp NODE_ENV=production \
      DATABASE_URL=$DB JWT_SECRET="$JWT_SECRET" PROVIDER_SECRET_KEY="$PROVIDER_SECRET_KEY" PORT=3734 \
      PUBLIC_ORIGIN=http://127.0.0.1:2734 CORS_ORIGINS=http://127.0.0.1:2734 TZ=UTC \
      node dist/main.js
    ;;
  gw)
    exec node "$S/gateway.mjs" "${2:-$S/dist-today}" 2734 3734
    ;;
  down)
    docker rm -f "$PG" >/dev/null 2>&1 || true
    ;;
  *) echo "usage: rig.sh db|api|gw [dist]|down" >&2; exit 2 ;;
esac
