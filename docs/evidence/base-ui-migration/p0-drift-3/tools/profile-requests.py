#!/usr/bin/env python3
"""Usage: profile-requests.py <out.json> <evidence.json>...

From the profile tests' evidence.json (harness.mjs writes it even for a failed test): per project the
captures reached, every API request (method and path, in order), the unhandled ones the fixture check
reports, and the page errors. The computed styles and timings of the raw files are left out."""
import json, sys
out = {}
for f in sys.argv[2:]:
    e = json.load(open(f))
    out[e['project']] = {'captures': [c['name'] for c in e['captures']],
                         'requests': [f"{r['method']} {r['path']}{'?' + r['query'] if r.get('query') else ''}" for r in e['requests']],
                         'unhandled': e['unhandled'], 'pageErrors': e['pageErrors']}
json.dump(dict(sorted(out.items())), open(sys.argv[1], 'w'), indent=1)
open(sys.argv[1], 'a').write('\n')
print(sys.argv[1], len(out))
