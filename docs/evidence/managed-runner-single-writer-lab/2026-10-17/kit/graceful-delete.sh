#!/usr/bin/env bash
# T02a: an operator's graceful deletion of the authorized Pod, with the Pod's own watch events and the mapping.
set -u
cd /root/.orbit/worktrees/49cb15ca-2b61-5210-8668-a7972fa8f259
export LAB_TEST_SERVER_DIR=/mnt/data/managed-runner-lab/test-server-t02a
E=/mnt/data/tmp/34hLQRqen3rnV1Wszrw9p/records
W="python3 -B scripts/managed-runner/lab/single-writer.py"
K="/mnt/data/managed-runner-lab/bin/kubectl --kubeconfig /mnt/data/managed-runner-lab/kubeconfig.json --context orbit-mr-lab -n orbit-mr-test"
POD=mr-01a14b6a-bbb3-703c-9da2-52e164ebf799
stamp() { date -u +%FT%T.%3NZ; }

timeout 200 $W mapping --watch 190 > "$E/36-watch-graceful-delete.jsonl" 2>&1 &
mapping_watch=$!
timeout 200 $K get pod "$POD" --watch --output-watch-events -o json > "$E/37-pod-events-graceful-delete.json" 2>&1 &
pod_watch=$!
sleep 3
uid=$($K get pod "$POD" -o jsonpath='{.metadata.uid}')
echo "delete requested $(stamp) uid=$uid" > "$E/35-graceful-delete.txt"
$K delete pod "$POD" --wait=false >> "$E/35-graceful-delete.txt" 2>&1
echo "delete answered $(stamp)" >> "$E/35-graceful-delete.txt"
sleep 120
kill "$mapping_watch" "$pod_watch" 2>/dev/null
echo "end $(stamp)" >> "$E/35-graceful-delete.txt"
cat "$E/35-graceful-delete.txt"
python3 - "$E/37-pod-events-graceful-delete.json" <<'PY'
import json, sys
text, decoder, i = open(sys.argv[1]).read(), json.JSONDecoder(), 0
while True:
    while i < len(text) and text[i].isspace():
        i += 1
    if i >= len(text):
        break
    try:
        event, i = decoder.raw_decode(text, i)
    except ValueError:
        print('unparsed tail:', text[i:i + 200]); break
    o = event['object']
    states = [(c['name'], list(c.get('state', {}).keys())) for c in (o['status'].get('containerStatuses') or [])]
    print(event['type'], o['metadata'].get('resourceVersion'), o['metadata']['uid'][:8], o['status'].get('phase'),
          'deletionTimestamp' if o['metadata'].get('deletionTimestamp') else '', states,
          [c.get('lastTransitionTime') for c in o['status'].get('conditions', []) if c['type'] == 'Ready'])
PY
cat "$E/36-watch-graceful-delete.jsonl"
