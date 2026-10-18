#!/usr/bin/env bash
# A Pod gone with no report still fences (its finalizer stripped, then force-deleted), and an API
# outage while FENCING changes nothing the owner sees.
# Usage: fence-outage.sh REPO EVIDENCE_DIR OWNER OUTAGE_SECONDS
set -euo pipefail
REPO=$1 E=$2 OWNER=$3 OUT=$4
M="python3 -B -I $REPO/scripts/managed-runner/lab/manager-lab.py"
K="/mnt/data/managed-runner-lab/bin/kubectl --kubeconfig /mnt/data/managed-runner-lab/kubeconfig.json --context orbit-mr-lab -n orbit-mr-test"
row() { docker exec orbit-mr-lab-pg psql -U orbit -d orbit -At -c "select json_build_object('at', now(), 'state', management_state, 'revision', revision, 'attempt', attempt, 'generation', generation, 'podUid', pod_uid, 'lastError', last_error, 'nextAttemptAt', next_attempt_at) from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = 't04-$OWNER@lab.invalid'"; }
RUNNER=$(docker exec orbit-mr-lab-pg psql -U orbit -d orbit -At -c "select runner_id from managed_runner m join \"user\" u on u.id = m.owner_id where u.email = 't04-$OWNER@lab.invalid'")
POD=mr-$RUNNER
row > "$E/rows.jsonl"
{
  echo "strip $(date -u +%FT%T.%3NZ)"
  $K patch pod "$POD" --type=json -p '[{"op":"test","path":"/metadata/finalizers/0","value":"orbit.dev/managed-runner-stop-report"},{"op":"remove","path":"/metadata/finalizers/0"}]'
  echo "force-delete $(date -u +%FT%T.%3NZ)"
  $K delete pod "$POD" --grace-period=0 --force --wait=false
  echo "gone? $($K get pod "$POD" -o name 2>&1) $(date -u +%FT%T.%3NZ)"
} > "$E/strip-and-delete.txt" 2>&1
$M watch 60 --until "$OWNER=FENCING" > "$E/watch-fence.jsonl" 2>&1
row >> "$E/rows.jsonl"
$M status "$OWNER" > "$E/status-fenced.json"
$M api-outage "$OUT" > "$E/outage.json" 2>&1 &
outage=$!
python3 -c 'import time,sys; time.sleep(int(sys.argv[1]))' $(( OUT / 2 ))
row >> "$E/rows.jsonl"
$M status "$OWNER" > "$E/status-during-outage.json"
wait $outage
python3 -c 'import time; time.sleep(15)'
row >> "$E/rows.jsonl"
$M status "$OWNER" > "$E/status-after-outage.json"
echo "done $(date -u +%FT%T.%3NZ)"
