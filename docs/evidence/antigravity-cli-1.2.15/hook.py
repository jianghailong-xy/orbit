#!/usr/bin/env python3
"""PreToolUse/PreInvocation hook for agy experiments: logs the payload, answers a fixed decision."""
import json, os, sys, time
name, decision = sys.argv[1], sys.argv[2]
delay = float(sys.argv[3]) if len(sys.argv) > 3 else 0
raw = sys.stdin.read()
try: payload = json.loads(raw)
except Exception: payload = {'raw': raw[:500]}
rec = {'t': time.time(), 'hook': name, 'pid': os.getpid(), 'ppid': os.getppid(), 'pgid': os.getpgid(0), 'sid': os.getsid(0),
       'keys': sorted(payload.keys()), 'toolCall': payload.get('toolCall'), 'stepIdx': payload.get('stepIdx'),
       'invocationNum': payload.get('invocationNum'), 'ORBIT_SESSION_ID': os.environ.get('ORBIT_SESSION_ID'),
       'ANTIGRAVITY_CONVERSATION_ID': os.environ.get('ANTIGRAVITY_CONVERSATION_ID'), 'cwd': os.getcwd()}
open('/var/tmp/agy-c0/hooks.log', 'a').write(json.dumps(rec) + '\n')
if delay: time.sleep(delay)
if decision == 'none':
    print('{}')
else:
    print(json.dumps({'decision': decision, 'reason': f'{name} says {decision}'}))
