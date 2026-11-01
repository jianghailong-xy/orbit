#!/bin/bash
# Serve the probe's stub on a spare port and read what the app reads, then the two writes it lets through.
cd /mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL/harness/.rgn-probe || exit 1
LOG=/mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL/runs/stubcheck.log
rm -f "$LOG"
python3 -u stub.py 18765 "$LOG" > /mnt/data/tmp/34pVMqwUhJE0RGvrL0ziL/runs/stubcheck.out 2>&1 &
PID=$!
for i in $(seq 1 20); do curl -fs -o /dev/null http://127.0.0.1:18765/api/agents && break; sleep 0.5; done
B=http://127.0.0.1:18765/api
python3 - "$B" <<'PY'
import json, sys, urllib.request
b = sys.argv[1]
def get(p):
    return json.load(urllib.request.urlopen(b + p))
r = get("/runners")[0]
print("runner", r["displayName"], r["region"])
print("engines", [(e["engine"], e["auth"], len(e.get("accounts") or [])) for e in r["engines"]])
rows = get("/sessions?view=open")
print("rows", [(x["id"], x["status"], x["runState"], x.get("error", "")[:40]) for x in rows])
print("S1 page", [(e["seq"], e["type"]) for e in get("/sessions/S1/events/page")["events"]])
print("providers", [(p["slug"], p["presetSlug"]) for p in get("/providers")])
req = urllib.request.Request(b + "/runners/hpc/region-check", method="POST", data=b"")
print("check again", json.load(urllib.request.urlopen(req)))
print("checkedAt now", get("/runners")[0]["region"]["checkedAt"])
req = urllib.request.Request(b + "/sessions/S1/config", method="PATCH", data=json.dumps({"provider": "deepseek"}).encode(),
                             headers={"Content-Type": "application/json"})
print("patch", json.load(urllib.request.urlopen(req)), get("/sessions/S1")["provider"])
PY
kill $PID
tail -5 "$LOG"
