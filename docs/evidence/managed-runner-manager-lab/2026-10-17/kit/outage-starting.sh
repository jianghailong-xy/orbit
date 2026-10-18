#!/usr/bin/env bash
# T02a's second finding on real k3s: the k3s API forward taken away while a runner is STARTING.
# Usage: outage-starting.sh REPO EVIDENCE_DIR SECONDS OWNER
set -euo pipefail
REPO=$1 E=$2 SECONDS_OUT=$3 OWNER=$4
M="python3 -B -I $REPO/scripts/managed-runner/lab/manager-lab.py"
row() { docker exec orbit-mr-lab-pg psql -U orbit -d orbit -At -c "select json_build_object('at', now(), 'state', management_state, 'revision', revision, 'attempt', attempt, 'generation', generation, 'podUid', pod_uid, 'lastError', last_error->>'code', 'nextAttemptAt', next_attempt_at) from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = 't04-$OWNER@lab.invalid'"; }
row > "$E/rows.jsonl"
$M status "$OWNER" > "$E/status-before.json"
$M api-outage "$SECONDS_OUT" > "$E/outage.json" 2>&1 &
outage=$!
# The row every 10 s while the forward is away.
for _ in $(seq 1 $(( SECONDS_OUT / 10 ))); do python3 -c 'import time; time.sleep(10)'; row >> "$E/rows.jsonl"; done
$M status "$OWNER" > "$E/status-during.json"
wait $outage
python3 -c 'import time; time.sleep(30)'
row >> "$E/rows.jsonl"
$M status "$OWNER" > "$E/status-after.json"
echo "done $(date -u +%FT%T.%3NZ)"
