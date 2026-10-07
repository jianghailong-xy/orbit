#!/usr/bin/env python3
"""Usage: transfer-frames.py <collected-dir>... — summarizes the recorded frames of the two promotion
tests that sample native animation progress across a modal transfer: frame times, the frames while the
notification was inside a modal, and opacity at each frame; plus the test's status from summary.json."""
import json, pathlib, sys
for d in map(pathlib.Path, sys.argv[1:]):
    status = {t['name']: t['status'] for t in json.loads((d / 'summary.json').read_text())['tests']}
    print(f'== {d}')
    for p in sorted(d.glob('*entrance-progress-survives*--native-entrance-transfer.json')):
        name = p.name.split('--native-entrance-transfer.json')[0]
        f = json.loads(p.read_text())
        gaps = [round(b['t'] - a['t']) for a, b in zip(f, f[1:])]
        owned = [(round(x['t']), round(x['opacity'], 3)) for x in f if x['owner']]
        mid = [x for x in f if x['owner'] and 0 < x['opacity'] < 1]
        print(f"  entrance {name.split('--')[0]:24} {status.get(name):10} frames {len(f):3} max gap {max(gaps) if gaps else None:4}ms  "
              f"first owned frame t={owned[0][0] if owned else None} opacity={owned[0][1] if owned else None}  owned mid-opacity frames {len(mid)}")
    for p in sorted(d.glob('*exit-keeps-its-own-native-progress*--native-exit.json')):
        name = p.name.split('--native-exit.json')[0]
        m = json.loads(p.read_text()); s = [x for x in m['samples'] if x['connected']]
        owners = sorted({str(x['owner']) for x in s})
        gaps = [round(b['t'] - a['t']) for a, b in zip(s, s[1:])]
        print(f"  exit {m['motion']:13} {name.split('--')[0]:24} {status.get(name):10} connected frames {len(s):3} t={[round(x['t']) for x in s]} owners {owners}")
