#!/usr/bin/env bash
# A crash of a runner still starting, as in T07's crash loop (task T07b): run-starting.sh OUT LABEL [NAME]
# The owner puts the READY runner to sleep and wakes it; once the woken Pod's `orbit run` has started, while the mapping
# is still STARTING, that process is SIGKILLed. The detach is the cluster's own. Writes LABEL.jsonl (the status read and
# the mapping row every 0.5 s, from before the wake until READY again), LABEL.attachments.jsonl, LABEL.sleep.json,
# LABEL.wake.json, LABEL.stop.json and LABEL.sequence.json.
set -uo pipefail
OUT=$1 LABEL=$2 NAME=${3:-amy}
KIT=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$KIT/../../../../.." && pwd)
cd "$REPO" || exit 2
T="python3 $KIT/t07b.py"
W="python3 scripts/managed-runner/lab/wake-lab.py"
mkdir -p "$OUT"
$T ready-for "$NAME" 125 > "$OUT/$LABEL.ready-before.json" || exit 1
$W action "$NAME" sleep > "$OUT/$LABEL.sleep.json" || exit 1
$W until "$NAME" SLEEPING --timeout 300 > "$OUT/$LABEL.until-sleeping.json" || exit 1
$T watch "$NAME" --out "$OUT/$LABEL.jsonl" --seconds 600 > "$OUT/$LABEL.watch.json" 2>&1 &
watcher=$!
$T attachments "$NAME" --out "$OUT/$LABEL.attachments.jsonl" --seconds 600 > /dev/null 2>&1 &
attachments=$!
sleep 2
$W action "$NAME" wake > "$OUT/$LABEL.wake.json"
$T kill-starting "$NAME" > "$OUT/$LABEL.stop.json"
echo "stop-exit=$?"
wait "$watcher"
echo "watch-exit=$?"
sleep 3
kill "$attachments" 2>/dev/null
$T sequence "$OUT/$LABEL.jsonl" > "$OUT/$LABEL.sequence.json"
echo "sequence-exit=$?"
