#!/usr/bin/env python3
"""Usage: evidence-digest.py <results dir> <out.json> [test-dir regex]

What the harness wrote for every test (src/web/ui-migration/harness.mjs writes evidence.json even when the
test fails): the screenshots it captured, its requests (method and path, with counts), the requests no
fixture answered (`unhandled`) and the page errors. Computed styles and timings are left out."""
import json, os, re, sys
from collections import Counter
root, out = sys.argv[1:3]
pat = re.compile(sys.argv[3]) if len(sys.argv) > 3 else None
rows = {}
for d in sorted(os.listdir(root)):
    p = os.path.join(root, d, 'evidence.json')
    if not os.path.isfile(p) or (pat and not pat.search(d)):
        continue
    e = json.load(open(p))
    reqs = Counter(f"{r['method']} {r['path']}" for r in e.get('requests', []))
    rows[d] = {'project': e.get('project'), 'test': e.get('test'), 'captures': [c['name'] for c in e.get('captures', [])],
               'unhandled': e.get('unhandled', []), 'pageErrors': e.get('pageErrors', []),
               'requests': dict(sorted(reqs.items()))}
json.dump(rows, open(out, 'w'), indent=1)
open(out, 'a').write('\n')
un = Counter(u for r in rows.values() for u in r['unhandled'])
print(json.dumps({'tests': len(rows), 'withUnhandled': sum(1 for r in rows.values() if r['unhandled']), 'unhandled': dict(un),
                  'withPageErrors': sum(1 for r in rows.values() if r['pageErrors'])}))
