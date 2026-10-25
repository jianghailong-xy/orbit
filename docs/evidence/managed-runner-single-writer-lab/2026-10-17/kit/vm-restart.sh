#!/usr/bin/env bash
# T02a: VM stop and start with the managed runner Pod writing; records into $E.
set -u
cd /root/.orbit/worktrees/49cb15ca-2b61-5210-8668-a7972fa8f259
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02a
E=/mnt/data/tmp/34hLQRqen3rnV1Wszrw9p/records
W="python3 -B scripts/managed-runner/lab/single-writer.py"
K="/mnt/data/managed-runner-lab/bin/kubectl --kubeconfig /mnt/data/managed-runner-lab/kubeconfig.json --context orbit-mr-lab -n orbit-mr-test"
POD=mr-01a14b6a-bbb3-703c-9da2-52e164ebf799
stamp() { date -u +%FT%T.%3NZ; }

timeout 1500 $W mapping --watch 1490 > "$E/28-watch-vm-restart.jsonl" 2>&1 &
watch=$!
sleep 3
{
  echo "pre-stop $(stamp)"
  $K exec "$POD" -c runner -- cat /var/lib/orbit/home/storage-verification/t02a-1/acknowledged.json; echo
  $K get pod "$POD" -o jsonpath='{.metadata.uid} {.status.phase} generation={.metadata.annotations.orbit\.dev/generation}{"\n"}'
  echo "stop.sh $(stamp)"
  bash scripts/managed-runner/lab/stop.sh
  echo "stop-exit=$? $(stamp)"
  sleep 20
  echo "start.sh $(stamp)"
  bash scripts/managed-runner/lab/start.sh
  echo "start-exit=$? $(stamp)"
} > "$E/27-vm-restart.txt" 2>&1

# Wait for the manager to see a running runner Pod reporting again, after the cluster was unreachable.
python3 - "$E/28-watch-vm-restart.jsonl" <<'PY'
import json, sys, time
path = sys.argv[1]
deadline = time.monotonic() + 900
while time.monotonic() < deadline:
    lines = [json.loads(l) for l in open(path) if l.startswith('{')]
    down = [i for i, l in enumerate(lines) if l.get('pod') == 'cluster unreachable']
    if down and any(':Running:' in (l.get('pod') or '') and l.get('reason') == 'MODEL_UNAVAILABLE' for l in lines[down[0]:]):
        print('runner reporting again after the restart'); sys.exit(0)
    time.sleep(5)
print('timed out waiting for the runner after the restart'); sys.exit(1)
PY
rc=$?
sleep 5
kill "$watch" 2>/dev/null
echo "done $(stamp) wait-exit=$rc" >> "$E/27-vm-restart.txt"
cat "$E/27-vm-restart.txt" | tail -25
cat "$E/28-watch-vm-restart.jsonl"
exit $rc
