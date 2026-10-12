#!/usr/bin/env python3
"""wait.py SESSION_ID [timeout] [minTurns] — on the ISOLATED stack (127.0.0.1:2886, not production Orbit): wait until
the session's turn settles (and numTurns >= minTurns), then print its state and its persisted run_event rows from the
stack's own Postgres (joined by the session's unique title). Neither contains a key."""
import json, subprocess, sys, time
sys.path.insert(0, '/var/tmp/p7-stack')
from api import api

sid = sys.argv[1]
deadline = time.time() + float(sys.argv[2] if len(sys.argv) > 2 else 300)
min_turns = int(sys.argv[3]) if len(sys.argv) > 3 else 0
while True:
    s = api('GET', f'/sessions/{sid}')
    settled = s.get('status') not in ('PENDING', 'RUNNING') and (s.get('numTurns') or 0) >= min_turns
    if settled or time.time() > deadline:
        break
    time.sleep(3)
keys = ('id', 'title', 'status', 'runStatus', 'provider', 'model', 'effort', 'permissionMode', 'numTurns', 'costUsd',
        'contextTokens', 'contextWindow', 'runtimeSessionId', 'error', 'endReason', 'lastAssistantText',
        'changedFiles', 'assignedRunnerId')
print(json.dumps({k: s.get(k) for k in keys}, ensure_ascii=False, indent=1))
title = (s.get('title') or '').replace("'", "''")
q = ("select e.seq, e.type, left(e.payload::text, 300) from run_event e join session s on s.id = e.session_id "
     f"where s.title = '{title}' order by e.seq")
out = subprocess.run(['docker', 'exec', 'p7-stack-pg', 'psql', '-U', 'orbit', '-d', 'orbit', '-AtF', ' | ', '-c', q],
                     capture_output=True, text=True)
print(out.stdout or out.stderr)
