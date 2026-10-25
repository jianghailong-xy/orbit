#!/usr/bin/env python3
"""Usage: compare-statuses.py <label>=<report.json> ... > statuses.json

Per-test statuses of several P0 runs (Playwright JSON reports, with or without attachment bodies): for each run the
stats and the (project, file, test) -> status map; then, for every run after the first, the tests whose status differs
from the first run's. Used to set this registration's runs beside the scroll-lock batch's standard P0 runs."""
import json, sys

runs = []
for arg in sys.argv[1:]:
    label, path = arg.split('=', 1)
    r = json.load(open(path))
    statuses = {}
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                statuses[f"{t['projectName']} | {sp.get('file')} | {sp['title']}"] = t['status']
        for c in s.get('suites', []):
            visit(c)
    for s in r['suites']:
        visit(s)
    runs.append((label, path, r['stats'], statuses))
first = runs[0]
out = {'runs': [{'label': l, 'report': p, 'stats': {k: s.get(k) for k in ('expected', 'unexpected', 'flaky', 'skipped')}, 'tests': len(st),
                 'unexpected': sorted(k for k, v in st.items() if v == 'unexpected')} for l, p, s, st in runs],
       'againstFirst': [{'label': l, 'sameTests': set(st) == set(first[3]),
                         'differentStatuses': sorted(k for k in set(st) | set(first[3]) if st.get(k) != first[3].get(k))} for l, p, s, st in runs[1:]]}
json.dump(out, sys.stdout, indent=1)
print()
