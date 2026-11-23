#!/usr/bin/env bash
# Start the real apiserver of a tip checkout against the walk's env file.
# usage: api.sh <tip checkout> <walk dir>   (writes <walk dir>/api.pid and api.log)
set -euo pipefail
tip=$1 walk=$2
cd "$tip/src/apiserver"
. "$walk/env"
nohup node build/main.js > "$walk/api.log" 2>&1 &
echo $! > "$walk/api.pid"
for _ in $(seq 1 120); do
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/api/health" 2>/dev/null; then echo "apiserver up on :$PORT (pid $(cat "$walk/api.pid"))"; exit 0; fi
  if ! kill -0 "$(cat "$walk/api.pid")" 2>/dev/null; then echo "apiserver exited"; tail -40 "$walk/api.log"; exit 1; fi
  sleep 1
done
echo "apiserver not healthy after 120 tries"; tail -40 "$walk/api.log"; exit 1
