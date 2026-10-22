#!/usr/bin/env bash
# D2 on real k3s: the QEMU forward of the k3s API taken away while the runners are READY.
# Usage: d2-outage-ready.sh REPO EVIDENCE_DIR SECONDS OWNER...
set -euo pipefail
REPO=$1 E=$2 SECONDS_OUT=$3; shift 3
M="python3 -B -I $REPO/scripts/managed-runner/lab/manager-lab.py"
rows() { docker exec orbit-mr-lab-pg psql -U orbit -d orbit -At -c "select json_agg(json_build_object('owner', (select email from \"user\" u where u.id = m.owner_id), 'state', management_state, 'revision', revision, 'attempt', attempt, 'generation', generation, 'podUid', pod_uid, 'lastError', last_error, 'nextAttemptAt', next_attempt_at, 'updatedAt', updated_at) order by created_at) from managed_runner m"; }
mark=$(date -u +%FT%T.%3NZ)
rows > "$E/d2-rows-before.json"
$M view > "$E/d2-view-before.json"
$M api-outage "$SECONDS_OUT" > "$E/d2-outage.json" 2>&1 &
outage=$!
python3 -c 'import time; time.sleep(int(__import__("sys").argv[1]))' $(( SECONDS_OUT / 2 ))
rows > "$E/d2-rows-during.json"
for owner in "$@"; do $M status "$owner" > "$E/d2-status-during-$owner.json"; done
curl -sk -o /dev/null -w '%{http_code} %{errormsg}\n' https://127.0.0.1:16443/readyz > "$E/d2-api-probe-during.txt" || true
wait $outage
# Three passes after the forward is back.
python3 -c 'import time; time.sleep(20)'
rows > "$E/d2-rows-after.json"
$M view > "$E/d2-view-after.json"
for owner in "$@"; do $M status "$owner" > "$E/d2-status-after-$owner.json"; done
sed 's/\x1b\[[0-9;]*m//g' "$LAB_TEST_SERVER_DIR/logs/apiserver.log" "$LAB_TEST_SERVER_DIR/logs/apiserver-b.log" \
  | awk -v since="$mark" '/ManagedRunnerManager/' | tail -n 60 > "$E/d2-manager-log.txt"
echo "marked $mark; done $(date -u +%FT%T.%3NZ)"
