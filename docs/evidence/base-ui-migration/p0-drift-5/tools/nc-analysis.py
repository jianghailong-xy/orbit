#!/usr/bin/env python3
"""Usage: nc-analysis.py <out.json> [check-name] [run-label]

A 1px negative control (temporary commit, local branch p0d5/<check-name>; default negative-control-1px, the
one on 6fb78dd11; negative-control-1px-final is the one on 3a36ab949):
 - the unchanged P0 command on it (checks/<check-name>): every failure, the screenshot it stopped at and that
   screenshot's expectation layer and registration;
 - its update-mode full matrix (runs/<run-label>, default full-fix-<check-name>) against the expectation assembled
   after both registrations (the first formal round's copy): which of the 44 newly registered screenshots fail the
   P0 comparator, and whether any other screenshot does."""
import json, subprocess, sys
B = '/mnt/data/tmp/34cFgyWHIYDslABFPloEM'
out = sys.argv[1]
name = sys.argv[2] if len(sys.argv) > 2 else 'negative-control-1px'
run = sys.argv[3] if len(sys.argv) > 3 else f'full-fix-{name}'
s = json.load(open(f'{B}/checks/{name}/summary.json'))
spec = [g for p in ('spec-a10.json', 'spec-a11.json') for g in json.load(open(f'{B}/scripts/{p}'))]
registered = {f: g['change'][-1] for g in spec for f in g['screenshots']}
cmp_path = f'{B}/cmp/expected-registered__{run}.json'
subprocess.run(['node', f'{B}/scripts/compare.cjs', f'{B}/checks/final-round-1/expected-screenshots-assembled',
                f'{B}/runs/{run}/snapshots', cmp_path], check=True, stdout=subprocess.DEVNULL)
rows = {r['file']: r for r in json.load(open(cmp_path))['rows']}
fails = sorted(f for f, r in rows.items() if r['p0Comparator'] != 'match')
result = {
    'command': {'stats': s['stats'], 'passed': s['passed'], 'skipped': s['skipped'],
                'failures': [{'project': u['project'], 'test': u['test'], 'screenshot': u['screenshot'], 'expectedLayer': u['expectedLayer'],
                              'registeredBy': registered.get(f"{u['project']}/{u['screenshot']}"), 'differentPixels': u['differentPixels']}
                             for u in s['unexpected']]},
    'updateMode': {'comparatorFails': len(fails), 'newlyRegisteredFailing': sum(f in registered for f in fails),
                   'newlyRegisteredPassing': sorted(f for f in registered if f not in fails),
                   'otherFailing': [f for f in fails if f not in registered],
                   'rows': {f: {k: rows[f][k] for k in ('differentPixels', 'maxChannelDelta', 'box', 'p0Comparator')} for f in fails}}}
json.dump(result, open(out, 'w'), indent=1, ensure_ascii=False)
open(out, 'a').write('\n')
print(json.dumps({'command': {k: result['command'][k] for k in ('passed', 'skipped')}, 'commandFailures': len(result['command']['failures']),
                  'allFailuresOnNewlyRegistered': all(f['registeredBy'] for f in result['command']['failures']),
                  'updateMode': {k: v for k, v in result['updateMode'].items() if k != 'rows'}}, indent=1))
