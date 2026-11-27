#!/usr/bin/env bash
# The real-stack walk of the cross-client check: postgres + the apiserver of <tip> (walk/up.sh, api.sh), the table's
# cases seeded as real rows and read as server payloads (server-payloads.cjs), the built console (<tip>/src/web/dist,
# `npx vite build` first), walk-cross.mjs; the stack is taken down whatever the walk answers.
# usage: run-walk.sh <tip checkout> <walk dir> <out dir> <pg port> <api port> <web port> <playwright module path>
set -u
T=$1 R=$2 OUT=$3 PG=$4 API=$5 WEB=$6 PW=$7
K=$(cd "$(dirname "$0")" && pwd); W=$K/../walk
rm -rf "$R" "$OUT"; mkdir -p "$R" "$OUT"
"$W/up.sh" "$T" "$R" "$PG" "$API" "$WEB" || exit 1
"$W/api.sh" "$T" "$R" || { "$W/down.sh" "$R"; exit 1; }
# seed.cjs makes the account through the real bootstrap; server-payloads.cjs then lends its password to the cases' owner.
(. "$R/env" && node "$W/seed.cjs" "$T" "$R" && node "$K/server-payloads.cjs" "$T" "$R") || { "$W/down.sh" "$R"; exit 1; }
nohup "$W/beat.sh" "$(cat "$R/pg.name")" "$(node -e "console.log(require('$R/world.json').runnerId)")" > "$R/beat.log" 2>&1 &
echo $! > "$R/beat.pid"
(cd "$T/src/web" && WALK_WEB_ROOT="$T/src/web" WALK_API="http://127.0.0.1:$API" WALK_WEB_PORT="$WEB" \
  nohup npx vite preview --config "$W/vite.preview.config.mjs" > "$R/preview.log" 2>&1 & echo $! > "$R/preview.pid")
for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$WEB/" && break; sleep 1; done
(. "$R/env" && node "$K/walk-cross.mjs" "$T" "$R" "http://127.0.0.1:$WEB" "http://127.0.0.1:$API" "$OUT" "$PW")
rc=$?
cp "$R/server-rows.json" "$OUT/" ; cp "$R/world.json" "$OUT/"
echo "walk-cross exit: $rc"
[ "${KEEP:-}" = 1 ] || "$W/down.sh" "$R"
exit $rc
