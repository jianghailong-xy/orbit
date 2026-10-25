#!/bin/bash
# run-probe.sh <tree> <probe-dir> <name> <probe file> [playwright args...]: an exploration probe on a tree.
set -u
TREE=$1 DIR=$2 NAME=$3 MATCH=$4; shift 4
RUN=/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/runs/$NAME
mkdir -p "$RUN/results"
echo "tree=$TREE head=$(git -C "$TREE" rev-parse HEAD) dirty=$(git -C "$TREE" status --porcelain -- src/web | wc -l) probe=$MATCH args=$* start=$(date -u +%FT%TZ) load=$(cut -d' ' -f1-3 /proc/loadavg)" > "$RUN/run.txt"
cd "$TREE/src/web"
export TREE RESULTS=$RUN/results PROBE_MATCH=$MATCH DIR TMPDIR=/mnt/data/tmp/34cC5ZWY0xCWquFuz3rNY/tmp
unshare -n bash -c 'ip link set lo up && exec nice -n 5 npx playwright test --config "$DIR/tree.config.mjs" "$@"' bash "$@" > "$RUN/output.txt" 2>&1
code=$?
echo "exit=$code end=$(date -u +%FT%TZ)" >> "$RUN/run.txt"
tail -3 "$RUN/output.txt"
exit $code
