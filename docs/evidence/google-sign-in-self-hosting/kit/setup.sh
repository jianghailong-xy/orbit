#!/usr/bin/env bash
# Isolated Orbit stack for the Google sign-in docs walkthrough (task 34bAKsy8Mmaf9guJTMTaw): a copy of the
# session worktree, its own PostgreSQL on 127.0.0.1:5676, apiserver on 3376, gateway + web on 2376, with
# PUBLIC_ORIGIN=http://localhost:2376 (the redirect URI a localhost test client would register).
# Nothing here talks to orbitd.io. No runner: Google sign-in needs none.
set -euo pipefail
WT=${WT:-/root/.orbit/worktrees/c1e13036-3b06-57e8-810e-b759d2d47ec5}
S=/var/tmp/google-doc-e2e
ORIGIN=http://localhost:2376
case "${1:-}" in
  build)
    mkdir -p "$S/src"
    rsync -a --delete --exclude node_modules --exclude .git --exclude build --exclude dist "$WT/" "$S/src/"
    for d in node_modules src/node_modules src/apiserver/node_modules src/web/node_modules src/shared/node_modules; do
      if [ -e "$WT/$d" ] && [ ! -e "$S/src/$d" ]; then cp -al "$WT/$d" "$S/src/$d"; fi
    done
    cd "$S/src"
    npm run build -w @orbit/shared > "$S/logs/build-shared.log" 2>&1
    (cd src/apiserver && npx prisma generate && npm run build) > "$S/logs/build-apiserver.log" 2>&1
    PUBLIC_ORIGIN=$ORIGIN npm run build -w @orbit/web > "$S/logs/build-web.log" 2>&1
    ls -l "$S/src/src/apiserver/dist/main.js" "$S/src/src/web/dist/index.html"
    echo "built from $WT at $(git -C "$WT" rev-parse HEAD) (+ $(git -C "$WT" status --porcelain | wc -l) uncommitted paths)"
    ;;
  db)
    docker rm -f google-doc-e2e-pg >/dev/null 2>&1 || true
    docker run -d --name google-doc-e2e-pg -e POSTGRES_PASSWORD=google_doc_pw -e POSTGRES_DB=orbit \
      -p 127.0.0.1:5676:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
    for i in $(seq 1 60); do
      docker exec google-doc-e2e-pg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
      sleep 1
    done
    sleep 2
    cd "$S/src/src/apiserver"
    DATABASE_URL=postgresql://postgres:google_doc_pw@127.0.0.1:5676/orbit npx prisma migrate deploy > "$S/logs/migrate.log" 2>&1
    tail -2 "$S/logs/migrate.log"
    ;;
  *) echo "usage: setup.sh build|db" >&2; exit 2 ;;
esac
