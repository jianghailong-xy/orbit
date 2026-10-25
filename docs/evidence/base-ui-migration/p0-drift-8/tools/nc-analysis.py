#!/usr/bin/env python3
"""Usage: nc-analysis.py <out.json> <check-name>

A 1px negative control (temporary commit on the local branch p0d8/<check-name>; patch nc-1px.diff: the Settings
"Session recaps" label 1px right, A15's new row; the task panel's "Engine" label 1px right, A16's new row; the turn
head's "Worked for" row 1px right, A17's new row):
 - the unchanged P0 command on it (checks/<check-name>): every failure, the screenshot it stopped at, that
   screenshot's expectation layer, and whether batch 8 registered it;
 - its update-mode full matrix (runs/full-<check-name>) against the expectation assembled after the registration
   ($B/expected-registered): which of batch 8's registered screenshots fail the P0 comparator, and whether any
   other screenshot does. As p0-drift-7/tools/nc-analysis.py."""
import json, subprocess, sys
B = '/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG'
out, name = sys.argv[1:3]
s = json.load(open(f'{B}/checks/{name}/summary.json'))
spec = [g for p in ('spec-a15.json', 'spec-a16.json', 'spec-a17.json') for g in json.load(open(f'{B}/scripts/{p}'))]
registered = {f: 'main drift, ' + '+'.join(g['change']) for g in spec for f in g['screenshots']}
acc = json.load(open(f'{B}/wt/reg/docs/evidence/base-ui-migration/p0-drift/accepted/registry.json'))['screenshots']
STEP = {'46e28aaa3': 'A15', 'e69765706': 'A16', 'd2e295917': 'A17'}
for e in acc:
    after = e['sameCommit']['after']['commit'][:9]
    if after in STEP: registered[e['screenshot']] = f'accepted, {STEP[after]}'
cmp_path = f'{B}/cmp/registered__full-{name}.json'
subprocess.run(['node', f'{B}/scripts/compare.cjs', f'{B}/expected-registered', f'{B}/runs/full-{name}/snapshots', cmp_path], check=True, stdout=subprocess.DEVNULL)
rows = {r['file']: r for r in json.load(open(cmp_path))['rows']}
fails = sorted(f for f, r in rows.items() if r['p0Comparator'] != 'match')
result = {
    'command': {'stats': s['stats'], 'passed': s['passed'], 'skipped': s['skipped'],
                'failures': [{'project': u['project'], 'test': u['test'], 'screenshot': u['screenshot'], 'expectedLayer': u['expectedLayer'],
                              'registeredBy': registered.get(f"{u['project']}/{u['screenshot']}"), 'differentPixels': u['differentPixels']}
                             for u in s['unexpected']]},
    'updateMode': {'registeredByBatch8': len(registered), 'comparatorFails': len(fails),
                   'registeredFailing': sum(f in registered for f in fails),
                   'registeredPassing': sorted(f for f in registered if f not in fails),
                   'otherFailing': [f for f in fails if f not in registered],
                   'failingPixels': {f: rows[f]['differentPixels'] for f in fails}}}
json.dump(result, open(out, 'w'), indent=1)
print(json.dumps({'command': {k: result['command'][k] for k in ('stats', 'passed', 'skipped')}, 'commandFailures': len(result['command']['failures']),
                  'commandFailuresOnBatch8': sum(1 for f in result['command']['failures'] if f['registeredBy']),
                  'updateMode': {k: (v if not isinstance(v, (list, dict)) else len(v)) for k, v in result['updateMode'].items()},
                  'registeredPassing': result['updateMode']['registeredPassing'], 'otherFailing': result['updateMode']['otherFailing']}, indent=1))
