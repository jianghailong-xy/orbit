#!/usr/bin/env bash
# Usage: run-entry.sh <tree> <config> <label> [playwright args]
# `npx playwright test --config ui-migration/<config> [args]` in <tree>/src/web, inside a private network
# namespace (the entry's fixed port is its own), then copies the entry's results directory to
# /mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/runs/<label>/results. NICE (default -10) sets the priority.
set -u
TREE=$1 CONFIG=$2 LABEL=$3; shift 3
BASE=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj
OUT=$BASE/runs/$LABEL
if [ -e "$OUT" ]; then echo "refusing: $OUT exists"; exit 2; fi
mkdir -p "$OUT" "$BASE/tmp"
case $CONFIG in
  overlays.config.mjs) RES=.overlays-results;;
  toasts.config.mjs) RES=.toasts-results;;
  choices.config.mjs) RES=.choices-results;;
  playwright.config.mjs) RES=.ui-migration-results;;
  *) RES=;;
esac
cd "$TREE/src/web" || exit 2
git -C "$TREE" rev-parse HEAD > "$OUT/head.txt"
git -C "$TREE" status --short > "$OUT/status.txt"
echo "config=$CONFIG args=$*" > "$OUT/command.txt"
start=$(date -u +%FT%TZ)
env -u FORCE_COLOR -u PUBLIC_ORIGIN TMPDIR=$BASE/tmp nice -n "${NICE:--10}" unshare -n bash -c 'ip link set lo up && NO_COLOR=1 npx playwright test --config "ui-migration/$0" "$@"' "$CONFIG" "$@" > "$OUT/command-output.txt" 2>&1
code=$?
end=$(date -u +%FT%TZ)
[ -n "$RES" ] && [ -d "$RES" ] && cp -a "$RES" "$OUT/results"
echo "exit $code start $start end $end" | tee "$OUT/exit.txt"
tail -6 "$OUT/command-output.txt"
exit $code
