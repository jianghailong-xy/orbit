#!/usr/bin/env bash
# One pass of walk.mjs with the rehearsal stack's settings (rehearse.sh's defaults).
#   walk.sh <label> <api base URL> d1|d2|d3|d4
set -euo pipefail
HERE=$(cd -P "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export LM_PROJECT=${LM_PROJECT:-orbit-link-t16} LM_DIR=${LM_DIR:-/mnt/tmp/t16/lm}
export LM_HTTP_PORT=${LM_HTTP_PORT:-57086} LM_LINK_PORT=${LM_LINK_PORT:-57443} LM_METRICS_PORT=${LM_METRICS_PORT:-57464}
export LM_NATS_PORT=${LM_NATS_PORT:-57422} LM_NATS_MONITOR_PORT=${LM_NATS_MONITOR_PORT:-57822} LM_PEBBLE_PORT=${LM_PEBBLE_PORT:-57500}
export OUT=${OUT:-/mnt/tmp/t16/out}
node "$HERE/walk.mjs" "$1" --api "$2" --code "$3" 2>&1 | tee "$OUT/walk-$1.log"
exit "${PIPESTATUS[0]}"
