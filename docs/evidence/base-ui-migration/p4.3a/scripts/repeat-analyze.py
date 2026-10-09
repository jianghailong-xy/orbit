#!/usr/bin/env python3
"""repeat-analyze.py V: the repeat runs (repeat.sh) beside round 5's formal runs, for the shots and page errors that
needed telling apart from run noise (run on round 5; its output is v1/repeat-r5/analysis.json). For each watched shot, every run's sha256 (first 12 hex) per tree, so a shot
that varies from run to run on one tree shows it; for every run, its tests' results and the page errors each test
recorded (evidence.json). Only reads."""
import glob, hashlib, json, os, sys

V = sys.argv[1]
WATCH = [('webkit-light-desktop', 'p43a-tasks-keys-space'), ('webkit-dark-desktop', 'p43a-tasks-keys-space'),
         ('webkit-light-phone', 'p43a-tasks-keys-space'), ('webkit-dark-phone', 'p43a-tasks-keys-space'),
         ('webkit-light-phone', 'p43a-delete-refused'), ('webkit-light-phone', 'p43a-delete'),
         ('webkit-light-desktop', 'p43a-header-live'), ('webkit-light-desktop', 'p43a-delete-refused')]
runs = {'ref': [('formal', f'{V}/runs5/p43a-ref-shots', f'{V}/runs5/p43a-ref-out')],
        'del': [('formal', f'{V}/runs5/p43a-del-shots', f'{V}/runs5/p43a-del-out')]}
for tree in ('ref', 'del'):
    for n in (1, 2, 3):
        d = f'{V}/repeat/{tree}-{n}'
        if os.path.isdir(d):
            runs[tree].append((f'repeat {n}', f'{d}/shots', f'{d}/out'))
digest = lambda path: hashlib.sha256(open(path, 'rb').read()).hexdigest()[:12] if os.path.exists(path) else '—'
out = {'shots': {}, 'runs': {}}
for env, shot in WATCH:
    key = f'{env}/{shot}'
    out['shots'][key] = {tree: {name: digest(f'{shots}/{env}/{shot}.png') for name, shots, _ in runs[tree]} for tree in runs}
for tree in runs:
    for name, _, results in runs[tree]:
        tests = []
        for evidence in sorted(glob.glob(f'{results}/*/evidence.json')):
            e = json.load(open(evidence))
            if 'header: status questions' in e['test'] or 'keys with a task open' in e['test']:
                tests.append({'project': e['project'], 'test': e['test'][:60], 'pageErrors': e.get('pageErrors', [])})
        report = f'{results}/report.json'
        stats = json.load(open(report)).get('stats') if os.path.exists(report) else None
        out['runs'][f'{tree} {name}'] = {'stats': stats and {k: stats.get(k) for k in ('expected', 'unexpected', 'flaky', 'skipped')},
                                         'pageErrors': [t for t in tests if t['pageErrors']]}
json.dump(out, sys.stdout, indent=1)
print()
