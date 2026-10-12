#!/usr/bin/env python3
"""Usage: compare-summary.py <out.json> <compare.json>...
One line per comparison (compare.cjs output): totals by class (same / noise / changed), the P0 comparator
failures, the largest noise (pixels, channel delta), whether every WebKit screenshot is byte-identical, and
the changed screenshots grouped by name."""
import json, os, sys
from collections import defaultdict
out = {}
for p in sys.argv[2:]:
    d = json.load(open(p))
    rows = [r for r in d['rows'] if not r.get('missing')]
    noise = [r for r in rows if r['class'] == 'noise']
    changed = defaultdict(list)
    for r in rows:
        if r['class'] == 'changed':
            proj, name = r['file'].split('/')
            changed[name].append(proj)
    out[os.path.basename(p)[:-5]] = {
        'total': len(rows), 'missing': len(d['rows']) - len(rows),
        'same': sum(r['class'] == 'same' for r in rows), 'noise': len(noise), 'changed': sum(len(v) for v in changed.values()),
        'p0ComparatorFails': sum(r['p0Comparator'] != 'match' for r in rows),
        'maxNoise': {'pixels': max([r['differentPixels'] for r in noise] or [0]), 'channel': max([r['maxChannelDelta'] for r in noise] or [0])},
        'webkitAllSame': all(r['class'] == 'same' for r in rows if r['file'].startswith('webkit')),
        'changedByName': {k: sorted(v) for k, v in sorted(changed.items())}}
json.dump(out, open(sys.argv[1], 'w'), indent=1)
open(sys.argv[1], 'a').write('\n')
for k, v in out.items():
    print(f"{k}: same {v['same']} noise {v['noise']} (max {v['maxNoise']['pixels']}px/{v['maxNoise']['channel']}) changed {v['changed']} "
          f"cmpFails {v['p0ComparatorFails']} webkitAllSame {v['webkitAllSame']} {', '.join(f'{n}x{len(p)}' for n, p in v['changedByName'].items())}")
