#!/usr/bin/env bash
# Isolated Orbit stack for the admin-area hint walkthrough (task 34bfJcxctbgThKlyWePPi): a copy of the
# session worktree, its own PostgreSQL on 127.0.0.1:5686, apiserver on 3386, gateway + web on 2386, with
# PUBLIC_ORIGIN=http://localhost:2386 (the redirect URI a localhost test client would register). Nothing
# here talks to orbitd.io. No runner: the admin area and Google sign-in need none. The two long-running
# pieces are kit/run-api.sh (ROTATE=1 for the second half) and kit/gateway.mjs.
set -euo pipefail
WT=${WT:-/root/.orbit/worktrees/b383fc05-9ab5-5418-b3ab-0ad3ab4262a5}
S=${S:-/var/tmp/google-sign-in-admin-hints}
ORIGIN=http://localhost:2386
case "${1:-}" in
  build)
    mkdir -p "$S/src" "$S/logs"
    # The tree, without the artifacts a build makes or the dependencies (laid out below).
    rsync -a --delete --exclude node_modules --exclude .git --exclude build --exclude dist "$WT/" "$S/src/"
    # Dependencies: the root is only read, so hardlink it; the apiserver's is a real copy because
    # `prisma generate` writes its client into it, and hardlinked writes would reach the worktree.
    for d in node_modules src/web/node_modules src/shared/node_modules; do
      rm -rf "$S/src/$d"; mkdir -p "$(dirname "$S/src/$d")"; cp -al "$WT/$d" "$S/src/$d"
    done
    rm -rf "$S/src/src/apiserver/node_modules"; cp -a "$WT/src/apiserver/node_modules" "$S/src/src/apiserver/node_modules"
    cd "$S/src"
    npm run build -w @orbit/shared > "$S/logs/build-shared.log" 2>&1
    # @orbit/shared resolves to THIS copy's built package, not the worktree's: the apiserver child reads
    # dist/index.js, and the worktree's is being rebuilt by other work while this stack runs. A real copy
    # rather than a link, so nothing here points back into the session's tree.
    rm -rf "$S/src/src/node_modules"; mkdir -p "$S/src/src/node_modules/@orbit"
    cp -a "$S/src/src/shared" "$S/src/src/node_modules/@orbit/shared"
    (cd src/apiserver && npx prisma generate && npm run build) > "$S/logs/build-apiserver.log" 2>&1
    PUBLIC_ORIGIN=$ORIGIN npm run build -w @orbit/web > "$S/logs/build-web.log" 2>&1
    ls -l "$S/src/src/apiserver/dist/main.js" "$S/src/src/web/dist/index.html"
    resolved=$(cd "$S/src/src/apiserver" && node -e "console.log(require.resolve('@orbit/shared'))")
    case "$resolved" in "$S/src/"*) echo "@orbit/shared resolves inside the copy: $resolved" ;; *) echo "REFUSING: @orbit/shared resolves to $resolved" >&2; exit 3 ;; esac
    echo "built from $WT at $(git -C "$WT" rev-parse HEAD) (+ $(git -C "$WT" status --porcelain | wc -l) uncommitted paths)"
    ;;
  db)
    docker rm -f google-admin-hints-pg >/dev/null 2>&1 || true
    docker run -d --name google-admin-hints-pg -e POSTGRES_PASSWORD=google_hints_pw -e POSTGRES_DB=orbit \
      -p 127.0.0.1:5686:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
    for i in $(seq 1 60); do
      docker exec google-admin-hints-pg pg_isready -h 127.0.0.1 -U postgres >/dev/null 2>&1 && break
      sleep 1
    done
    sleep 2
    cd "$S/src/src/apiserver"
    DATABASE_URL=postgresql://postgres:google_hints_pw@127.0.0.1:5686/orbit npx prisma migrate deploy > "$S/logs/migrate.log" 2>&1
    tail -2 "$S/logs/migrate.log"
    ;;
  *) echo "usage: setup.sh build|db" >&2; exit 2 ;;
esac
