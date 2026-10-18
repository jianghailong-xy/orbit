#!/usr/bin/env bash
# The P8 maintenance canary, on an isolated deployment of this branch: a throwaway PostgreSQL, this branch's
# apiserver and wiki-worker started the way their containers start them (node dist/main.js,
# node dist/wiki-worker/main.js), a fake System model, and this project line's runner binary reading a checkout of
# this branch. ORBIT_WIKI_EXECUTOR=canary with BOTH canary accounts listed:
#
#   account A  its space's maintenance becomes three `maintain` wiki jobs, each run by the wiki worker;
#   account B  holds no provider row at all: the owner's own PATCH turns its maintenance on and one run completes;
#   the door   the published runner's `orbit wiki maintain`, its run context, dossiers and cursor answer 409.
#
# The drive's record (docs/evidence/wiki-maintain-server-canary/evidence.json in a real run) is printed at the end
# and left in $LOG/drive.json; the stack is torn down either way.
set -uo pipefail

# The worktree this branch is checked out in, and a scratch directory for the stack.
W=${WORKTREE:-$(cd "$(dirname "$0")/../../.." && pwd)}
KIT=$(cd "$(dirname "$0")" && pwd)
WORK=${CANARY_WORK:-/tmp/wiki-maintain-server-canary}
API_PORT=${API_PORT:-$((3700 + RANDOM % 200))}
MODEL_PORT=${MODEL_PORT:-$((8900 + RANDOM % 90))}
MODEL=p8-maintain-system-model
# The runner binary the space's repository operations are handed to: this project line's runner (0.1.225 in the
# evidence below), which declares wiki-repo-op/v1. Read before the ORBIT_* variables are cleared below, and kept
# under a name of its own.
RUNNER_BIN=${RUNNER_BIN:-${ORBIT_BIN:-orbit}}
PG=p8maint-pg-$$
LOG=$WORK/logs
rm -rf "$WORK"; mkdir -p "$LOG"
for v in $(env | cut -d= -f1 | grep -E '^(ORBIT_|CLAUDE|ANTHROPIC_)'); do unset "$v"; done

cleanup() {
  echo "==> stopping"
  pkill -f "$KIT/fake-model.mjs" 2>/dev/null || true
  for pid in "${RUNNER_B_PID:-}" "${RUNNER_PID:-}" "${WORKER_PID:-}" "${API_PID:-}" "${MODEL_PID:-}"; do [ -n "$pid" ] && kill "$pid" 2>/dev/null; done
  sleep 1
  docker rm -f -v "$PG" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo "==> building this branch's dist"
( cd "$W/src/apiserver" && npm run build > "$LOG/build.log" 2>&1 ) || { tail -20 "$LOG/build.log"; exit 1; }
echo "    dist built $(stat -c %y "$W/src/apiserver/dist/main.js" | cut -d. -f1)"
echo "==> this branch: $(git -C "$W" rev-parse --short HEAD), $(git -C "$W" status --short | wc -l) paths changed"

TIP=$(git -C "$W" rev-parse HEAD)
echo "==> the checkout the runner reads: a clone of this branch at $WORK/repo (HEAD $TIP)"
git clone -q --bare --no-hardlinks "$W" "$WORK/origin.git" || exit 1
git -C "$WORK/origin.git" branch -f main "$TIP" || exit 1
git clone -q "$WORK/origin.git" "$WORK/repo" || exit 1
git -C "$WORK/repo" checkout -q -B main "$TIP" || exit 1

echo "==> postgres ($PG)"
docker run -d --name "$PG" -e POSTGRES_USER=orbit -e POSTGRES_PASSWORD=orbit -e POSTGRES_DB=orbit \
  -e PGDATA=/pgdata --tmpfs /pgdata:size=1g -p 127.0.0.1::5432 postgres:16-alpine >/dev/null || exit 1
PGPORT=$(docker port "$PG" 5432/tcp | head -1 | sed 's/.*://')
for _ in $(seq 1 60); do docker exec "$PG" pg_isready -U orbit >/dev/null 2>&1 && break; sleep 1; done
export DATABASE_URL="postgresql://orbit:orbit@127.0.0.1:$PGPORT/orbit"
echo "==> migrations on 127.0.0.1:$PGPORT"
( cd "$W/src/apiserver" && "$W/node_modules/.bin/prisma" migrate deploy 2>&1 | tail -1 ) || exit 1
docker exec "$PG" psql -U orbit -d orbit -tAc "SELECT migration_name FROM _prisma_migrations ORDER BY migration_name DESC LIMIT 1"

export API_BASE="http://127.0.0.1:$API_PORT" APP_DIST="$W/src/apiserver/dist" CHECKOUT="$WORK/repo" RUNNER_HOME="$WORK/runner-home" \
       RUNNER_HOME_B="$WORK/runner-home-b" SHARED_DIST="$W/src/shared/dist" JWT_LIB="$W/node_modules/jsonwebtoken" ORBIT_BIN="$RUNNER_BIN"
echo "==> seed (two accounts; B holds no provider row)"
( cd "$W/src/apiserver" && node "$KIT/seed.cjs" ) > "$LOG/seed.json" || { cat "$LOG/seed.json"; exit 1; }
OWNER_A=$(node -e "console.log(require('$LOG/seed.json').ownerA)")
OWNER_B=$(node -e "console.log(require('$LOG/seed.json').ownerB)")
echo "ownerA=$OWNER_A spaceA=$(node -e "console.log(require('$LOG/seed.json').spaceA)")"
echo "ownerB=$OWNER_B spaceB=$(node -e "console.log(require('$LOG/seed.json').spaceB)")"

echo "==> fake System model on :$MODEL_PORT"
( cd "$KIT" && exec env MODEL="$MODEL" node "$KIT/fake-model.mjs" "$MODEL_PORT" "$LOG/hits.jsonl" > "$LOG/model.log" 2>&1 ) &
MODEL_PID=$!

export JWT_SECRET="p8-maintain-$(openssl rand -hex 16)"
start_api() {
  ( cd "$W/src/apiserver" && exec env PROVIDER_SECRET_KEY="$(openssl rand -base64 32)" PORT="$API_PORT" CORS_ORIGINS="$API_BASE" PUBLIC_ORIGIN="$API_BASE" \
     ORBIT_WIKI=on ORBIT_WATCHES=off ORBIT_WIKI_EXECUTOR=canary ORBIT_WIKI_EXECUTOR_CANARY_OWNERS="$OWNER_A,$OWNER_B" \
     node dist/main.js >> "$LOG/apiserver.log" 2>&1 ) &
  API_PID=$!
  for _ in $(seq 1 300); do curl -fsS "$API_BASE/api/health" >/dev/null 2>&1 && return 0; sleep 1; done
  return 1
}
echo "==> apiserver on :$API_PORT (ORBIT_WIKI_EXECUTOR=canary, owners=$OWNER_A,$OWNER_B)"
start_api || { echo "the apiserver never answered"; tail -30 "$LOG/apiserver.log"; exit 1; }

echo "==> wiki-worker (ORBIT_WIKI_EXECUTOR=canary, System model $MODEL on :$MODEL_PORT)"
( cd "$W/src/apiserver" && exec env ORBIT_WIKI_MODEL_BASE_URL="http://127.0.0.1:$MODEL_PORT" ORBIT_WIKI_MODEL_API_KEY="sk-p8-maintain-local" \
     ORBIT_WIKI_MODEL="$MODEL" ORBIT_WIKI_MODEL_CONCURRENCY=4 ORBIT_WIKI_EXECUTOR=canary ORBIT_WIKI_EXECUTOR_CANARY_OWNERS="$OWNER_A,$OWNER_B" \
     node dist/wiki-worker/main.js > "$LOG/worker.log" 2>&1 ) &
WORKER_PID=$!

echo "==> this project line's runners ($("$RUNNER_BIN" --version 2>/dev/null)): one per account, reading their own checkouts"
( exec env ORBIT_HOME="$WORK/runner-home" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 "$RUNNER_BIN" run > "$LOG/runner.log" 2>&1 ) &
RUNNER_PID=$!
( exec env ORBIT_HOME="$WORK/runner-home-b" ORBIT_NO_SELFUPDATE=1 ORBIT_NO_ENGINE_UPDATE=1 "$RUNNER_BIN" run > "$LOG/runner-b.log" 2>&1 ) &
RUNNER_B_PID=$!

echo "==> three runs of account A, one of account B, and the door's refusals"
( cd "$W/src/apiserver" && node "$KIT/drive.mjs" "$LOG/seed.json" "$LOG/hits.jsonl" "$LOG/drive.json" ) > "$LOG/drive.out" 2> "$LOG/drive.err"
DRIVE=$?
cp "$LOG/drive.json" "$KIT/evidence.json" 2>/dev/null || true
node -e "
const out = require('$LOG/drive.json');
console.log('checks:', JSON.stringify(out.checkSummary));
for (const one of out.checks ?? []) console.log(one.ok ? 'PASS' : 'FAIL', one.what, one.detail ?? '');
" 2>/dev/null || cat "$LOG/drive.err"
echo "==> exit $DRIVE; evidence in $LOG/drive.json (and docs/evidence/wiki-maintain-server-canary/evidence.json)"
exit $DRIVE
