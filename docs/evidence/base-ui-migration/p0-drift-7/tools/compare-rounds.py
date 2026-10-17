#!/usr/bin/env python3
"""Usage: compare-rounds.py <round-1 summary.json> <round-2 summary.json> [out.json]
Two consecutive P0 rounds, test by test (project, file, title): status in each, and for the unexpected
ones the screenshot each stopped at and Playwright's different-pixel count. identical = same statuses
for every test and the same failures with the same pixel counts."""
import json, sys
a, b = (json.load(open(p)) for p in sys.argv[1:3])
key = lambda t: (t['project'], t['file'], t['test'])
ta, tb = ({key(t): t['status'] for t in s['tests']} for s in (a, b))
fa, fb = ({key(u): (u['screenshot'], u['differentPixels'], u['locator']) for u in s['unexpected']} for s in (a, b))
out = {'tests': [len(ta), len(tb)], 'statusDifferences': [list(k) + [ta.get(k), tb.get(k)] for k in sorted(set(ta) | set(tb)) if ta.get(k) != tb.get(k)],
       'failures': [[*k, fa.get(k), fb.get(k)] for k in sorted(set(fa) | set(fb))],
       'stats': [a['stats'], b['stats']]}
out['identical'] = not out['statusDifferences'] and fa == fb
if len(sys.argv) > 3: json.dump(out, open(sys.argv[3], 'w'), indent=1)
print(json.dumps({'identical': out['identical'], 'tests': out['tests'], 'failures': len(out['failures'])}))
