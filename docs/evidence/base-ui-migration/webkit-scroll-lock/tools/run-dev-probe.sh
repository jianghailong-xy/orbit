#!/usr/bin/env bash
# Usage: [DEV_PROBE_CONFIG=<entry config>] run-dev-probe.sh <tree> <label> <probe file> [playwright args] — copies a
# dev-only probe (named so the entry's testMatch takes it) into <tree>/src/web/ui-migration, runs it with that entry's
# dev server (default overlays.config.mjs) in a private network namespace, then moves the copy out of the tree.
set -u
WT=$1 LABEL=$2 PROBE=$3; shift 3
CFG=${DEV_PROBE_CONFIG:-overlays.config.mjs}
P=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes
TR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trash/$LABEL
UI=$WT/src/web/ui-migration
cp "$P/$PROBE" "$UI/$PROBE"
cd "$WT/src/web"
env -u FORCE_COLOR -u PUBLIC_ORIGIN TMPDIR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/tmp NO_COLOR=1 PROBE_OUT=$P/$LABEL.jsonl \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config "ui-migration/$CFG" "$PROBE" --output "$P/out-$LABEL" "$@" > "$P/$LABEL.txt" 2>&1
code=$?
RES=.${CFG%%.config.mjs}-results
cp "$WT/src/web/$RES/report.json" "$P/$LABEL.report.json" 2>/dev/null
mkdir -p "$TR"; mv "$UI/$PROBE" "$TR/"
echo "exit $code" | tee -a "$P/$LABEL.txt"
tail -4 "$P/$LABEL.txt"
exit $code
