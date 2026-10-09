#!/usr/bin/env bash
# Usage: [PROBE_CONFIG=<config>] run-probe.sh <tree> <label> <probe file> [playwright args] — copies the probe and
# its config (default probe.config.mjs) from /mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes into
# <tree>/src/web/ui-migration, runs it on the tree's existing production build (preview server) in a private
# network namespace, then moves both copies out of the tree again (into the scratch trash directory).
set -u
WT=$1 LABEL=$2 PROBE=$3; shift 3
CFG=${PROBE_CONFIG:-probe.config.mjs}
P=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/probes
T=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/trash/$LABEL
UI=$WT/src/web/ui-migration
cp "$P/$PROBE" "$UI/$PROBE"; cp "$P/$CFG" "$UI/$CFG"
cd "$WT/src/web"
env -u FORCE_COLOR -u PUBLIC_ORIGIN TMPDIR=/mnt/data/tmp/34cBi0yt6bFcSmbJFgDPj/tmp NO_COLOR=1 PROBE_LABEL=$LABEL PROBE_OUT=$P/$LABEL.jsonl \
  unshare -n bash -c 'ip link set lo up && exec "$@"' bash npx playwright test --config "ui-migration/$CFG" "$PROBE" "$@" > "$P/$LABEL.txt" 2>&1
code=$?
mkdir -p "$T"; mv "$UI/$PROBE" "$UI/$CFG" "$T/"
echo "exit $code" | tee -a "$P/$LABEL.txt"
tail -5 "$P/$LABEL.txt"
exit $code
