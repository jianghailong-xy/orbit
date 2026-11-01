#!/usr/bin/env bash
# Runs drill.py's timeline and sampler as transient units outside the Orbit runner's cgroup, so neither depends on the
# session (or the runner) that started them, and dumps the evidence when the timeline ends.
#
# Usage: run-drill.sh start          start the sampler and the timeline (each only if it is not running already)
#        run-drill.sh wait OUT       wait for the timeline to end, stop the sampler, dump the evidence into OUT;
#                                    exits with the timeline's own exit code
# A watcher that dies (a recycled session) leaves both units running: start another `wait`.
# Environment: as drill.py (LRL_DIR, LRL_PROFILE, ...).
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
LRL_DIR=${LRL_DIR:-/mnt/data/tmp/lrle}
PROFILE=${LRL_PROFILE:-full}
DRILL=orbit-lrl-drill
SAMPLER=orbit-lrl-sampler

unit() {  # unit NAME LOG COMMAND...
  local name=$1 log=$2
  shift 2
  systemd-run --unit="$name" --collect --quiet -p MemoryMax=512M \
    -p Environment=HOME=/root -p Environment=PATH=/usr/local/bin:/usr/bin:/bin -p Environment=LANG=C.UTF-8 \
    -p Environment=LRL_DIR="$LRL_DIR" -p Environment=LRL_PROFILE="$PROFILE" \
    -p StandardOutput=append:"$log" -p StandardError=append:"$log" "$@"
}

case "${1:-}" in
  start)
    mkdir -p "$LRL_DIR/records" "$LRL_DIR/logs"
    rm -f "$LRL_DIR/records/sampler.stop"
    systemctl is-active --quiet "$SAMPLER" || unit "$SAMPLER" "$LRL_DIR/logs/sampler.log" /usr/bin/python3 "$HERE/drill.py" sample
    if ! systemctl is-active --quiet "$DRILL"; then
      rm -f "$LRL_DIR/records/run.exit"
      unit "$DRILL" "$LRL_DIR/logs/drill.log" /bin/bash -c \
        "/usr/bin/python3 '$HERE/drill.py' run; echo \$? > '$LRL_DIR/records/run.exit'"
    fi
    echo "started: $(systemctl is-active "$SAMPLER") sampler, $(systemctl is-active "$DRILL") timeline (profile $PROFILE)"
    ;;
  wait)
    OUT=${2:?OUT}
    while systemctl is-active --quiet "$DRILL"; do sleep 10; done
    touch "$LRL_DIR/records/sampler.stop"
    while systemctl is-active --quiet "$SAMPLER"; do sleep 2; done
    code=$(cat "$LRL_DIR/records/run.exit" 2>/dev/null || echo 255)
    echo "timeline exit: $code"
    tail -5 "$LRL_DIR/logs/drill.log" || true
    /usr/bin/python3 "$HERE/drill.py" dump "$OUT" | tail -3
    exit "$code"
    ;;
  *) echo "usage: run-drill.sh start | wait OUT" >&2; exit 2 ;;
esac
