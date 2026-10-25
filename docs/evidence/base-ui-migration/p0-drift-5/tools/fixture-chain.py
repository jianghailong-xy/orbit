#!/usr/bin/env python3
"""Usage: fixture-chain.py <out.json> <run label>...

For each run (runs/<label>/evidence-digest.json, written from every test's evidence.json): the commit and
runner, how many tests read GET /api/wiki/spaces/<id>/share and how often, every request no fixture answered
(`unhandled`, by test), page errors, and the tests' pass/fail counts. As p0-drift-3/tools/fixture-chain.py."""
import json, sys
B = '/mnt/data/tmp/34cFgyWHIYDslABFPloEM'
out, labels = sys.argv[1], sys.argv[2:]
SHARE = 'GET /api/wiki/spaces/2zwQZ2hd93IvLb59t6pDl/share'
rows = {}
for label in labels:
    meta = json.load(open(f'{B}/runs/{label}/meta.json'))
    digest = json.load(open(f'{B}/runs/{label}/evidence-digest.json'))
    reading = {k: v['requests'].get(SHARE, 0) for k, v in digest.items() if v['requests'].get(SHARE)}
    unhandled = {k: v['unhandled'] for k, v in digest.items() if v['unhandled']}
    rows[label] = {'commit': meta['commit'], 'runner': meta['runner'].rsplit('/', 1)[-1], 'runnerCommit': meta['runnerCommit'],
                   'exit': meta['exit'], 'environment': meta['environment'], 'stats': meta['stats'], 'screenshots': meta['screenshots'],
                   'testsReadingShare': len(reading), 'shareRequestsPerTest': sorted(set(reading.values())),
                   'unhandledSet': sorted({u for v in unhandled.values() for u in v}), 'testsWithUnhandled': len(unhandled),
                   'unhandledByTest': unhandled, 'pageErrors': {k: v['pageErrors'] for k, v in digest.items() if v['pageErrors']}}
json.dump(rows, open(out, 'w'), indent=1)
open(out, 'a').write('\n')
for label, r in rows.items():
    print(f"{label}: {r['commit'][:9]} runner {r['runner']} exit {r['exit']} {r['stats']} share-readers {r['testsReadingShare']} "
          f"x{r['shareRequestsPerTest']} unhandled {r['unhandledSet']} in {r['testsWithUnhandled']} tests, pageErrors {len(r['pageErrors'])}")
