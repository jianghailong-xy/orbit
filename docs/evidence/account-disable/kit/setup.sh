#!/usr/bin/env bash
# Isolated Orbit stack for disabling an account through the real UI (task X1, 34bAKsrDHaf9mkC8rfKeq): a copy of the
# session worktree, its own PostgreSQL on 127.0.0.1:5696, apiserver on 3396, gateway + web on 2396, with
# PUBLIC_ORIGIN=http://localhost:2396. Nothing here talks to orbitd.io or to Google, and no runner is started.
set -euo pipefail
WT=${WT:-/root/.orbit/worktrees/634c1799-a1dc-5e90-b1e5-35508dee6ea8}
S=/var/tmp/x1-disable-e2e
ORIGIN=http://localhost:2396
mkdir -p "$S/logs" "$S/shots"
case "${1:-}" in
  build)
    mkdir -p "$S/src"
    # docs/ is left out: 2 GB of evidence, and nothing the build reads.
    rsync -a --delete --exclude node_modules --exclude .git --exclude build --exclude dist --exclude /docs "$WT/" "$S/src/"
    # Hard links: the copy runs on the worktree's installation, its Prisma client generated from this same schema.
    for d in node_modules src/apiserver/node_modules src/web/node_modules src/shared/node_modules; do
      if [ -e "$WT/$d" ] && [ ! -e "$S/src/$d" ]; then cp -al "$WT/$d" "$S/src/$d"; fi
    done
    cd "$S/src"
    npm run build -w @orbit/shared > "$S/logs/build-shared.log" 2>&1
    (cd src/apiserver && npm run build) > "$S/logs/build-apiserver.log" 2>&1
    PUBLIC_ORIGIN=$ORIGIN npm run build -w @orbit/web > "$S/logs/build-web.log" 2>&1
    ls -l "$S/src/src/apiserver/dist/main.js" "$S/src/src/web/dist/index.html"
    echo "built from $WT at $(git -C "$WT" rev-parse HEAD) (+ $(git -C "$WT" status --porcelain | wc -l) uncommitted paths)"
    ;;
  db)
    docker rm -f x1-disable-e2e-pg >/dev/null 2>&1 || true
    docker run -d --name x1-disable-e2e-pg -e POSTGRES_PASSWORD=x1_disable_pw -e POSTGRES_DB=orbit \
      -p 127.0.0.1:5696:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
    for _ in $(seq 1 60); do
      docker exec x1-disable-e2e-pg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
      sleep 1
    done
    sleep 2
    cd "$S/src/src/apiserver"
    DATABASE_URL=postgresql://postgres:x1_disable_pw@127.0.0.1:5696/orbit npx prisma migrate deploy > "$S/logs/migrate.log" 2>&1
    tail -2 "$S/logs/migrate.log"
    ;;
  down)
    docker rm -f x1-disable-e2e-pg >/dev/null 2>&1 || true
    ;;
  *) echo "usage: setup.sh build|db|down" >&2; exit 2 ;;
esac
