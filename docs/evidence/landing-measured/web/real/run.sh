#!/bin/bash
# usage: run.sh — with the stack up (setup.sh up; run-api.sh and `node gateway.mjs` running, web and apiserver built):
# seeds a fresh database through the real services, then captures and reads back. Re-run setup.sh up and restart the
# apiserver between runs: the seed bootstraps the owner, which only works on an empty database.
set -e
. "$(dirname "$0")/env.sh"
export SEED_FILE=/var/tmp/lm-real-seed.json
umask 077
node "$HERE/seed.cjs" 2>/dev/null | tail -1 > "$SEED_FILE"
exec node "$HERE/capture.mjs"
