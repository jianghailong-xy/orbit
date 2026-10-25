#!/usr/bin/env python3
"""T06b's wake timings, read from the lab's own records (no credential is read or printed).

beats.jsonl (kit/beats.sh, every 0.5 s): each mapping's state and when it was entered, its runner's last
heartbeat as the test server stamped it, and its sessions' last claims — all the test server's clocks.
timeline.jsonl (wake-lab.py record, every second): the Pods as k3s reports them.

For each generation that reached READY: when STARTING was entered, when its Pod was first seen Running,
its first heartbeat (the first stamp after STARTING began), its first claim (the earliest claim after
STARTING began) and READY, with the differences that matter here: first claim minus first heartbeat
(negative would mean it claimed before it was seen) and READY minus first claim.

  timings.py BEATS TIMELINE [--owner NAME]
"""
import argparse
import json
from datetime import datetime, timezone


def ts(value):
    if value is None:
        return None
    text = value.replace(' ', 'T')
    if text.endswith('Z'):
        text = text[:-1] + '+00:00'
    parsed = datetime.fromisoformat(text)
    # The runner's and the session's columns are timestamps without a zone, stored in UTC.
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def iso(value):
    return value.isoformat(timespec='milliseconds').replace('+00:00', 'Z') if value else None


def seconds(a, b):
    return round((a - b).total_seconds(), 3) if a and b else None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('beats')
    parser.add_argument('timeline')
    parser.add_argument('--owner')
    args = parser.parse_args()

    # Pod Running, first seen per Pod UID prefix, from the recorder's view of k3s.
    running = {}
    with open(args.timeline) as handle:
        for line in handle:
            line = json.loads(line)
            at = ts(line['at'])
            for _runner, pod in ((line.get('k8s') or {}).get('pods') or {}).items():
                uid, phase = pod.split(':')[0], pod.split(':')[1]
                if phase == 'Running' and uid not in running:
                    running[uid] = at

    generations = {}
    with open(args.beats) as handle:
        for line in handle:
            line = line.strip()
            if not line.startswith('{'):
                continue
            sample = json.loads(line)
            for m in sample['m']:
                owner = m['owner'].removeprefix('t06-')
                if args.owner and owner != args.owner:
                    continue
                key = (owner, m['gen'])
                g = generations.setdefault(key, {'owner': owner, 'generation': m['gen'], 'beats': set(), 'claims': set()})
                if m['state'] == 'STARTING' and 'starting' not in g:
                    g['starting'] = ts(m['entered'])
                if m['pod']:
                    g['pod'] = m['pod']
                if m['state'] == 'READY' and 'ready' not in g:
                    g['ready'] = ts(m['entered'])
                if m['beat']:
                    g['beats'].add(ts(m['beat']))
                for claim in m['claims'] or []:
                    if claim['claimed']:
                        g['claims'].add(ts(claim['claimed']))

    rows = []
    for (owner, generation), g in sorted(generations.items()):
        starting, ready = g.get('starting'), g.get('ready')
        if not starting or not ready:
            continue
        first_beat = min((b for b in g['beats'] if b > starting), default=None)
        first_claim = min((c for c in g['claims'] if c > starting), default=None)
        pod_running = running.get(g.get('pod'))
        rows.append({
            'owner': owner, 'generation': generation, 'pod': g.get('pod'),
            'starting': iso(starting), 'podRunningSeen': iso(pod_running), 'firstHeartbeat': iso(first_beat),
            'firstClaim': iso(first_claim), 'ready': iso(ready),
            'podRunningToFirstHeartbeatS': seconds(first_beat, pod_running),
            'firstClaimMinusFirstHeartbeatS': seconds(first_claim, first_beat),
            'readyMinusFirstClaimS': seconds(ready, first_claim),
            'readyMinusFirstHeartbeatS': seconds(ready, first_beat),
            'startingToReadyS': seconds(ready, starting),
        })
    print(json.dumps(rows, indent=1))


if __name__ == '__main__':
    main()
