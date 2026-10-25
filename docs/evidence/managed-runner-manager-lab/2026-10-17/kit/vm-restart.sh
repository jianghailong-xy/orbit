#!/usr/bin/env bash
# D7 on real k3s: the lab VM stopped and booted (a node restart) while runners are READY and STARTING.
# Usage: vm-restart.sh REPO EVIDENCE_DIR
set -euo pipefail
REPO=$1 E=$2
M="python3 -B -I $REPO/scripts/managed-runner/lab/manager-lab.py"
LAB=$REPO/scripts/managed-runner/lab
rows() { docker exec orbit-mr-lab-pg psql -U orbit -d orbit -At -c "select json_agg(json_build_object('owner', (select email from \"user\" u where u.id = m.owner_id), 'state', management_state, 'revision', revision, 'attempt', attempt, 'generation', generation, 'podUid', pod_uid, 'lastError', last_error->>'code', 'nextAttemptAt', next_attempt_at, 'at', now()) order by created_at) from managed_runner m"; }
rows > "$E/rows-before.json"
$M view > "$E/view-before.json"
echo "stop $(date -u +%FT%T.%3NZ)" >> "$E/times.txt"
bash "$LAB/stop.sh" > "$E/stop.txt" 2>&1
echo "stopped $(date -u +%FT%T.%3NZ)" >> "$E/times.txt"
rows > "$E/rows-off.json"
python3 -c 'import time; time.sleep(20)'
rows > "$E/rows-off-20s.json"
echo "start $(date -u +%FT%T.%3NZ)" >> "$E/times.txt"
bash "$LAB/start.sh" > "$E/start.txt" 2>&1
echo "healthy $(date -u +%FT%T.%3NZ)" >> "$E/times.txt"
rows > "$E/rows-healthy.json"
