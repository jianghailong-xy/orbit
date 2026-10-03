#!/usr/bin/env python3
"""Experiment hook: logs its payload; answers per event from the control file."""
import json, os, sys, time
event = sys.argv[1]
raw = sys.stdin.read()
try:
    payload = json.loads(raw)
except Exception:
    payload = {'raw': raw[:4000]}
rec = {'t': time.time(), 'event': event, 'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgid(0),
       'payload': payload, 'cwd': os.getcwd(), 'argv': sys.argv,
       'env': {k: v for k, v in os.environ.items() if k.startswith(('ORBIT', 'ANTIGRAVITY', 'EXP_'))}}
log = os.environ.get('HOOKLOG', '/var/tmp/agy-p3/hooks.log')
with open(log, 'a') as f:
    f.write(json.dumps(rec) + '\n')
ctl = os.environ.get('HOOKCTL', '/var/tmp/agy-p3/ctl.json')
try:
    c = json.load(open(ctl))
except Exception:
    c = {}
d = c.get(event, {})
# per-tool override for PreToolUse
if event == 'PreToolUse':
    name = (payload.get('toolCall') or {}).get('name')
    d = c.get('PreToolUse:' + str(name), d)
if d.get('sleep'):
    time.sleep(d['sleep'])
if 'out' in d:
    sys.stdout.write(d['out'])
if 'stderr' in d:
    sys.stderr.write(d['stderr'])
if 'exit' in d:
    sys.exit(d['exit'])
if 'out' not in d:
    print('{}')
