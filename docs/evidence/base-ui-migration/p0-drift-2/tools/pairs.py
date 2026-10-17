#!/usr/bin/env python3
"""Usage: pairs.py <out.json> <labelA>:<labelB> ...
Runs compare.cjs for each pair of runs (runs/<label>/snapshots, A is the earlier one) and collects every
screenshot's classification (same / noise / changed, p0-drift noise rule) per pair into one JSON."""
import json, subprocess, sys
out, pairs = sys.argv[1], sys.argv[2:]
R = '/var/tmp/p0d2/runs'
result = {}
for pair in pairs:
    a, b = pair.split(':')
    tmp = f'/var/tmp/p0d2/cmp/{a}__{b}.json'
    subprocess.run(['mkdir', '-p', '/var/tmp/p0d2/cmp'])
    subprocess.run(['node', '/var/tmp/p0d2/scripts/compare.cjs', f'{R}/{a}/snapshots', f'{R}/{b}/snapshots', tmp], check=True, stdout=subprocess.DEVNULL)
    rows = json.load(open(tmp))['rows']
    result[pair] = {r['file']: ('missing' if r.get('missing') else r['class'], r.get('differentPixels'), r.get('maxChannelDelta'), r.get('p0Comparator', '')[:60]) for r in rows}
json.dump(result, open(out, 'w'), indent=1)
for pair, rows in result.items():
    changed = sorted(f for f, v in rows.items() if v[0] == 'changed')
    print(pair, 'changed', len(changed), 'missing', sum(1 for v in rows.values() if v[0] == 'missing'), 'noise', sum(1 for v in rows.values() if v[0] == 'noise'))
