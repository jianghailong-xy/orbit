#!/usr/bin/env python3
"""Every sleep and every start of the T06 run, read off the recorder's timeline (logs/timeline.jsonl.gz).

The recorder (scripts/managed-runner/lab/wake-lab.py record-loop) wrote one line whenever a mapping, a runner's heartbeat
or a managed Pod changed, polling about once a second, so each time below is when the recorder saw the change: up to about
1.2 s after it happened. Exact turn times are the database's own, in the records (conversation_turn, run_event).

  sleep: READY -> DRAINING (asked) -> accepted by the runner -> Pod gone -> SLEEPING (generation retired)
  start: SLEEPING/REQUESTED/WAITING_CAPACITY -> STARTING with a Pod -> Pod Running -> READY

Usage: timings.py TIMELINE.jsonl.gz
"""
import datetime
import gzip
import json
import sys


def t(value):
    return datetime.datetime.fromisoformat(value)


lines = [json.loads(line) for line in gzip.open(sys.argv[1], 'rt') if line.startswith('{')]
lines = [line for line in lines if 'error' not in line]
owners = sorted({o for line in lines for o, v in line.items() if isinstance(v, dict) and 'state' in v})
result = {}
for owner in owners:
    sleeps, starts, current, start = [], [], None, None
    previous, previous_gen = None, -1
    for line in lines:
        v = line.get(owner)
        if not isinstance(v, dict) or 'state' not in v:
            continue
        pods = (line.get('k8s') or {}).get('pods') or {}
        pod = next((p for p in pods.values() if v['pod'] and p.startswith(v['pod'])), None)
        if v['state'] == 'DRAINING' and v['drain'] == 'asked' and current is None:
            current = {'generation': v['gen'], 'drainAsked': line['at']}
        if current is not None:
            if v['drain'] == 'accepted' and 'accepted' not in current:
                current['accepted'] = line['at']
            if v['state'] == 'DRAINING' and v['pod'] and not pod and 'podGone' not in current:
                current['podGone'] = line['at']
            if v['state'] == 'SLEEPING' or v['gen'] > current['generation']:
                # A sleep shorter than the recorder's poll shows only as the next generation's first state.
                if v['state'] != 'SLEEPING':
                    current['sleepingNotSeen'] = True
                current['sleeping'] = line['at']
                current['seconds'] = round((t(line['at']) - t(current['drainAsked'])).total_seconds(), 1)
                sleeps.append(current)
                current = None
            elif v['state'] == 'READY' and previous == 'DRAINING':
                current['calledOff'] = line['at']
                sleeps.append(current)
                current = None
        woke = previous in (None, 'SLEEPING', 'FAILED', 'READY') or (previous == 'DRAINING' and v['gen'] > previous_gen)
        if v['state'] in ('REQUESTED', 'WAITING_CAPACITY', 'PROVISIONING', 'STARTING') and woke and start is None:
            start = {'from': previous if previous != 'DRAINING' else 'SLEEPING (not seen)', 'generation': v['gen'], 'left': line['at'],
                     'firstState': v['state'], 'reason': v['reason']}
        if start is not None:
            if v['state'] == 'WAITING_CAPACITY':
                start['waitedForCapacity'] = True
            if v['state'] == 'STARTING' and pod and 'podCreated' not in start:
                start['podCreated'] = line['at']
            if pod and ':Running:' in pod and 'podRunning' not in start:
                start['podRunning'] = line['at']
            if v['state'] == 'READY':
                start['ready'] = line['at']
                start['generation'] = v['gen']
                start['secondsToReady'] = round((t(line['at']) - t(start['left'])).total_seconds(), 1)
                starts.append(start)
                start = None
            elif v['state'] == 'FAILED':
                start['failed'] = {'at': line['at'], 'reason': v['reason']}
                starts.append(start)
                start = None
            elif v['state'] in ('DRAINING', 'SLEEPING'):
                # Drained before it was READY: an owner disabled meanwhile.
                start['endedBeforeReady'] = {'at': line['at'], 'state': v['state']}
                starts.append(start)
                start = None
        previous, previous_gen = v['state'], v['gen']
    result[owner] = {'sleeps': sleeps, 'starts': starts}
print(json.dumps(result, indent=1))
