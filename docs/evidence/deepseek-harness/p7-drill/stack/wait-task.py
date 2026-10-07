#!/usr/bin/env python3
"""wait-task.py TASK_ID [timeout] — on the ISOLATED stack (127.0.0.1:2886): wait for a task to leave OPEN/IN_PROGRESS,
then print it, the model-routing report and the task's run sessions' recorded spend."""
import json, sys, time
sys.path.insert(0, '/var/tmp/p7-stack')
from api import api

tid = sys.argv[1]
deadline = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 600)
while True:
    t = api('GET', f'/tasks/{tid}')
    if t.get('status') not in ('OPEN', 'IN_PROGRESS') or time.time() > deadline:
        break
    time.sleep(5)
print(json.dumps({k: t.get(k) for k in ('id', 'title', 'status', 'provider', 'model', 'outcome', 'verdict')}, ensure_ascii=False))
for s in t.get('sessions') or []:
    print('session', json.dumps({k: s.get(k) for k in ('id', 'status', 'model', 'route')}, ensure_ascii=False)[:600])
print('REPORT', json.dumps(api('GET', '/tasks/model-routing/report'), ensure_ascii=False, indent=1))
