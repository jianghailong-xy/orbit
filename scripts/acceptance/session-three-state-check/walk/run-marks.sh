#!/usr/bin/env bash
# The display walk in one go: postgres + the apiserver of <tip>, the seven cases, the controls, the two-run task and the
# marks cases, the built console (<tip>/src/web/dist, `npx vite build` first), then walk-marks.mjs; the stack is taken
# down whatever the walk answers.
# usage: run-marks.sh <tip checkout> <walk dir> <out dir> <pg port> <api port> <web port> [playwright module path]
set -u
T=$1 R=$2 OUT=$3 PG=$4 API=$5 WEB=$6 PW=${7:-$1/node_modules/playwright}
K=$(cd "$(dirname "$0")" && pwd)
rm -rf "$R" "$OUT"; mkdir -p "$R" "$OUT"
"$K/up.sh" "$T" "$R" "$PG" "$API" "$WEB" || exit 1
"$K/api.sh" "$T" "$R" || { "$K/down.sh" "$R"; exit 1; }
(. "$R/env" && node "$K/seed.cjs" "$T" "$R" && node "$K/seed-control.cjs" "$T" "$R" && node "$K/seed-task-runs.cjs" "$T" "$R" \
  && node "$K/seed-marks.cjs" "$T" "$R") || { "$K/down.sh" "$R"; exit 1; }
nohup "$K/beat.sh" "$(cat "$R/pg.name")" "$(node -e "console.log(require('$R/seed.json').runnerId)")" > "$R/beat.log" 2>&1 &
echo $! > "$R/beat.pid"
(cd "$T/src/web" && WALK_WEB_ROOT="$T/src/web" WALK_API="http://127.0.0.1:$API" WALK_WEB_PORT="$WEB" \
  nohup npx vite preview --config "$K/vite.preview.config.mjs" > "$R/preview.log" 2>&1 & echo $! > "$R/preview.pid")
for _ in $(seq 1 60); do curl -fsS -o /dev/null "http://127.0.0.1:$WEB/" && break; sleep 1; done
node "$K/walk-marks.mjs" "$R" "http://127.0.0.1:$WEB" "http://127.0.0.1:$API" "$OUT" "$PW"
rc=$?
echo "walk-marks exit: $rc"
"$K/down.sh" "$R"
exit $rc
