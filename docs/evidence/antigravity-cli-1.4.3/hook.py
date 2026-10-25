#!/usr/bin/env python3
"""Experiment hook: appends its payload to the log and allows (PreToolUse) / says nothing (PreInvocation)."""
import json, sys, time
event, log = sys.argv[1], sys.argv[2]
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except Exception:
    payload = {'raw': raw[:4000]}
with open(log, 'a') as f:
    f.write(json.dumps({'t': time.time(), 'event': event, 'payload': payload}) + '\n')
if event == 'PreToolUse':
    print('{"decision":"allow"}')
