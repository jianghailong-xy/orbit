#!/bin/bash
# P7 drill stack (task 34ZvIEYA65e0h1SG2cmfD): the P6-accepted candidate 5e5bfca23 on loopback
# (gateway 127.0.0.1:2886, api :3886, postgres :5986 tmpfs) with two test runners of its own.
# Its database starts as a copy of the P6 test deployment (/var/tmp/p6-stack), which stays untouched.
set -euo pipefail
D=/var/tmp/p7-stack; S=$D/src; ORIGIN=http://127.0.0.1:2886; PG=p7-stack-pg
CANDIDATE=${CANDIDATE:-a5d3d20d7}   # rev 1 ran on 5e5bfca23; rev 2 = project tip with D3 + F-P7-1
REPO=/root/.orbit/worktrees/afd46c9f-1e62-5e1e-a01a-5ab6e4f84960
case "${1:-}" in
source)   # candidate source = git archive of the P6-accepted commit
  rm -rf "$S"; mkdir -p "$S"; git -C "$REPO" archive "$CANDIDATE" | tar -x -C "$S"
  git -C "$REPO" rev-parse "$CANDIDATE^{commit}" > "$D/BASE_SHA"; cat "$D/BASE_SHA" ;;
verify)   # the deployed tree (build outputs and deps aside) is exactly the candidate commit
  T=$(mktemp -d); git -C "$REPO" archive "$(cat "$D/BASE_SHA")" | tar -x -C "$T"
  diff -rq --exclude=node_modules --exclude=dist --exclude=.prisma --exclude='*.tsbuildinfo' --exclude=build "$T" "$S" \
    && echo "deployed src == $(cat "$D/BASE_SHA")"; rm -rf "$T"
  sha256sum "$D"/bin/orbit-*; strings "$D/bin/orbit-candidate" | grep -o 'claude,codex,opencode[a-z,]*' | sort -u ;;
build)
  cd "$S"
  npm ci --no-audit --no-fund > "$D/npm-ci.log" 2>&1
  npm run build -w @orbit/shared > "$D/build-shared.log" 2>&1
  npm run prisma:generate -w @orbit/apiserver > "$D/build-prisma.log" 2>&1
  npm run build -w @orbit/apiserver > "$D/build-apiserver.log" 2>&1
  PUBLIC_ORIGIN=$ORIGIN npm run build -w @orbit/web > "$D/build-web.log" 2>&1
  (cd src/runner-go && go build -o "$D/bin/orbit-candidate" .) > "$D/build-runner.log" 2>&1
  [ -f "$D/bin/orbit-legacy" ] || cp /usr/local/bin/orbit "$D/bin/orbit-legacy"   # the production runner release before dsh (0.1.211), copied once in rev 1
  "$D/bin/orbit-candidate" --version; "$D/bin/orbit-legacy" --version
  sha256sum "$D"/bin/orbit-* ;;
db)       # copy of the P6 test deployment's database, same provider secret so stored keys still decrypt
  cp /var/tmp/p6-stack/secrets.env "$D/secrets.env"; chmod 600 "$D/secrets.env"
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
  docker run -d --name "$PG" -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit -e POSTGRES_DB=orbit \
    -p 127.0.0.1:5986:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine >/dev/null
  until docker exec "$PG" pg_isready -h 127.0.0.1 -U orbit >/dev/null 2>&1; do sleep 1; done; sleep 2
  docker exec p6-stack-pg pg_dump -U orbit -d orbit -Fc > "$D/p6-db.dump"
  docker exec -i "$PG" pg_restore -U orbit -d orbit --no-owner < "$D/p6-db.dump"
  (cd "$S/src/apiserver" && DATABASE_URL=postgresql://orbit:orbit@127.0.0.1:5986/orbit npx prisma migrate deploy) > "$D/migrate.log" 2>&1
  tail -2 "$D/migrate.log" ;;
runners)  # runner A = the P6 runner's identity and state (dsh-sessions, engines), re-pointed here; runner B = new, legacy
  rm -rf "$D/runner-a" "$D/runner-b"; cp -a /var/tmp/p6-stack/runner-home "$D/runner-a"
  python3 - "$D/runner-a/config.json" "$ORIGIN" <<'EOF'
import json, sys
p, origin = sys.argv[1], sys.argv[2]
c = json.load(open(p)); c['serverUrl'] = origin; c['name'] = 'hpc-p7-a'; c['workDir'] = '/var/tmp/p7/work-a'
json.dump(c, open(p, 'w'), indent=2)
EOF
  mkdir -p /var/tmp/p7/work-a /var/tmp/p7/work-b "$D/runner-b"
  [ -d /var/tmp/p7/work-a/.git ] || cp -a /var/tmp/p6/smoke2/. /var/tmp/p7/work-a/
  [ -d /var/tmp/p7/work-b/.git ] || cp -a /var/tmp/p6/smoke2/. /var/tmp/p7/work-b/
  TOKEN=$(python3 -c "import json;print(json.load(open('$D/bootstrap.json'))['accessToken'])")
  curl -fsS -X POST "$ORIGIN/api/runners/enrollment-tokens" -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{}' > "$D/enroll-b.json"
  ENROLL=$(python3 -c "import json;print(json.load(open('$D/enroll-b.json'))['token'])")
  ( for v in $(env | cut -d= -f1 | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_|DSH_)'); do unset "$v"; done
    export ORBIT_HOME=$D/runner-b ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1
    cd /var/tmp/p7/work-b && "$D/bin/orbit-legacy" register --server "$ORIGIN" --token "$ENROLL" --name hpc-p7-b \
      --workdir /var/tmp/p7/work-b --no-service --force ) > "$D/register-b.log" 2>&1
  tail -2 "$D/register-b.log" ;;
login)    # the copied owner from P6 (owner@p6-stack.invalid)
  curl -fsS -X POST "$ORIGIN/api/auth/login" -H 'content-type: application/json' \
    -d '{"email":"owner@p6-stack.invalid","password":"'"${STACK_PASSWORD:?set STACK_PASSWORD to the stack owner password}"'"}' > "$D/bootstrap.json"
  python3 -c "import json;d=json.load(open('$D/bootstrap.json'));print('logged in', d['user']['email'])" ;;
*) echo "usage: $0 source|build|verify|db|runners|login" >&2; exit 2 ;;
esac
