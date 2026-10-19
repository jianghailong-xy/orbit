#!/usr/bin/env bash
# One recorded restart of a READY runner in the lab (task T07b): run.sh OUT LABEL kill|oom natural|held [NAME]
#   OUT     the records directory
#   kill    SIGKILL to `orbit run` in the runner's Pod (manager-lab.py kill-runner); oom: the container run out of
#           memory (t07b.py oom)
#   held    the stopped Pod's own VolumeAttachment kept by t07b.py's finalizer until the stored reason has been
#           VOLUME_STILL_ATTACHED for 10 s, as a slow detach keeps it; natural: the cluster's own detach
# First waits until the runner has been READY for 125 s (twice backoffMaxSeconds), so each stop counts from attempt 1.
# Writes LABEL.jsonl (the status read and the mapping row every 0.5 s, until READY again), LABEL.attachments.jsonl,
# LABEL.stop.json, LABEL.hold-*.json and LABEL.sequence.json.
set -uo pipefail
OUT=$1 LABEL=$2 HOW=$3 HOLD=$4 NAME=${5:-amy}
KIT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$KIT/../../../../.." && pwd)
cd "$REPO" || exit 2
T="python3 $KIT/t07b.py"
W="python3 scripts/managed-runner/lab/wake-lab.py"
mkdir -p "$OUT"
$T ready-for "$NAME" 125 > "$OUT/$LABEL.ready-before.json" || exit 1
$T watch "$NAME" --out "$OUT/$LABEL.jsonl" --seconds 600 > "$OUT/$LABEL.watch.json" 2>&1 &
watcher=$!
$T attachments "$NAME" --out "$OUT/$LABEL.attachments.jsonl" --seconds 600 > /dev/null 2>&1 &
attachments=$!
sleep 3
if [ "$HOLD" = held ]; then $T detach-hold "$NAME" on > "$OUT/$LABEL.hold-on.json" || exit 1; fi
if [ "$HOW" = kill ]; then $W kill-runner "$NAME" > "$OUT/$LABEL.stop.json"; else $T oom "$NAME" > "$OUT/$LABEL.stop.json"; fi
echo "stop-exit=$?"
if [ "$HOLD" = held ]; then $T detach-hold "$NAME" off --after 10 > "$OUT/$LABEL.hold-off.json"; echo "release-exit=$?"; fi
wait "$watcher"
echo "watch-exit=$?"
sleep 3
kill "$attachments" 2>/dev/null
$T sequence "$OUT/$LABEL.jsonl" > "$OUT/$LABEL.sequence.json"
echo "sequence-exit=$?"
