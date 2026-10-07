#!/usr/bin/env python3
"""Usage: attribution-summary.py <out.json> — same-environment attribution of the new P0 failures on the
project tip. For each main first-parent commit run (runs/attr-*): the breakpoint-959-wiki / profile /
profile-validation screenshots compared with the P0 expectation (P0.2 here) and with the previous run in
main order, and each run's test outcomes (a locator failure shows as a failed test)."""
import json, subprocess, sys, pathlib
B = pathlib.Path('/var/tmp/p23b1')
EXP = B / 'trees/tip/src/web/.ui-migration-results/expected-screenshots'
def cmp(a, b):
    out = subprocess.check_output(['node', str(B / 'scripts/regions.cjs'), str(a), str(b)], text=True)
    d = json.loads(out); return {'differentPixels': d.get('pixels'), 'maxChannelDelta': d.get('maxChannelDelta')}
def comparator(actual, expected):
    js = ("const W='/root/.orbit/worktrees/bf593adf-7724-576c-968c-fcd10880a595/node_modules/';"
          "const c=require(W+'playwright-core/lib/coreBundle').utils.getComparator('image/png');const fs=require('fs');"
          f"const r=c(fs.readFileSync('{actual}'),fs.readFileSync('{expected}'),{{maxDiffPixels:0}});console.log(r?r.errorMessage.split('\\n')[0]:'match')")
    return subprocess.check_output(['node', '-e', js], text=True).strip()
def outcomes(run):
    r = json.load(open(run / 'output/report.json')); out = {}
    def visit(s):
        for sp in s.get('specs', []):
            for t in sp['tests']:
                errs = [e.get('message', '').split('\n')[0][:160] for res in t['results'] for e in res.get('errors', [])]
                out[f"{t['projectName']} | {sp['title']}"] = {'status': t['status'], 'error': errs[0] if errs else None}
        for c in s.get('suites', []): visit(c)
    for s in r['suites']: visit(s)
    return out
result = {}
groups = {'breakpoints': (['383594ee2', '4920dab40', '0982d8ed8', 'dcfb5adf6', '51f0cdfee', 'be0f8c22a', 'b2e05492f', '30cf89786', 'f86211ec3'], ['breakpoint-959-wiki.png']),
          'profile': (['85b18b646', '86c6d2d4d'], ['profile.png', 'profile-validation.png']),
          'wiki': (['51f0cdfee', 'be0f8c22a'], ['wiki-home.png'])}
for group, (shas, shots) in groups.items():
    rows = []; prev = None
    for sha in shas:
        run = B / f'runs/attr-{group}-{sha}'
        if not run.exists(): continue
        commit = subprocess.check_output(['git', '-C', str(B / f'trees/m-{sha}'), 'rev-parse', 'HEAD'], text=True).strip()
        row = {'commit': commit, 'subject': subprocess.check_output(['git', '-C', str(B / f'trees/m-{sha}'), 'log', '-1', '--format=%s'], text=True).strip(),
               'outcomes': outcomes(run), 'screenshots': {}}
        for snap in sorted((run / 'snapshots').glob('*/*.png')):
            rel = f'{snap.parent.name}/{snap.name}'
            if snap.name not in shots: continue
            e = EXP / rel
            entry = {'vsP0Expectation': comparator(snap, e) if e.exists() else None, 'vsP0ExpectationPixels': cmp(e, snap) if e.exists() else None}
            if prev and (prev / 'snapshots' / rel).exists(): entry['vsPreviousRun'] = cmp(prev / 'snapshots' / rel, snap)
            row['screenshots'][rel] = entry
        rows.append(row); prev = run
    result[group] = rows
json.dump(result, open(sys.argv[1], 'w'), indent=1)
for group, rows in result.items():
    print('==', group)
    for row in rows:
        fails = [k for k, v in row['outcomes'].items() if v['status'] == 'unexpected']
        shots = {k: (v['vsP0Expectation'][:40], v.get('vsPreviousRun', {}).get('differentPixels')) for k, v in row['screenshots'].items()}
        print(f"  {row['commit'][:9]} {row['subject'][:60]:60} failed tests {len(fails)} {shots}")
