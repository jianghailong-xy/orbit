#!/usr/bin/env python3
"""Usage: isolation-summary.py <worktree> <out.json>
The isolation record that the six profile-validation references cite in migrationFix.isolation (p0-drift README
main drift rule 7): the premises (git facts), the trees and runs, proof (i) X vs X+F with the notification box,
the B1 signature it is checked against and the run-to-run noise outside the box, and proof (ii) X^1+F vs P0.2.
Inputs: /var/tmp/p0d2/cmp/{isolation,outside-noise,geometry-*}.json and the runs' meta.json."""
import json, subprocess, sys
W, OUT = sys.argv[1:3]
git = lambda *a: subprocess.check_output(['git', '-C', W, *a], text=True).strip()
anc = lambda a, b: subprocess.run(['git', '-C', W, 'merge-base', '--is-ancestor', a, b]).returncode == 0
patch_id = lambda spec: subprocess.check_output(f'git -C {W} {spec} | git -C {W} patch-id --stable', shell=True, text=True).split()[0]
C = '/var/tmp/p0d2/cmp'
iso, noise = json.load(open(f'{C}/isolation.json')), json.load(open(f'{C}/outside-noise.json'))
b1 = {r['screenshot']: r for r in json.load(open(f'{W}/docs/evidence/base-ui-migration/p2.3-b1/root-cause/toast-box-tip-to-fix-v2.json'))['rows']}
b0 = {r['screenshot']: r for r in json.load(open(f'{W}/docs/evidence/base-ui-migration/p2.3-b1/root-cause/toast-box-e361ee373-to-57f792135.json'))['rows']}
meta = lambda label: {k: v for k, v in json.load(open(f'/var/tmp/p0d2/runs/{label}/meta.json')).items() if k in ('commit', 'runnerCommit', 'args', 'started', 'finished', 'exit', 'environment', 'stats', 'screenshots')}
X, X1, F = git('rev-parse', 'd233a6cd0'), git('rev-parse', 'e6786d077'), git('rev-parse', '3ec9cf83d')
XF, X1F = git('rev-parse', 'p0d2/d233a6cd0-plus-b1-fix'), git('rev-parse', 'p0d2/e6786d077-plus-b1-fix')
main = git('rev-parse', 'refs/remotes/origin/main')
record = {
    'rule': 'p0-drift README, main drift rule 7: bounded exception authorised by the coordinator on 2026-10-07 (request 34bWpmojjlLPL0Exs1kSw, recorded on task 34bTKzXFSRGjnDevEBJlh).',
    'screenshots': list(iso['proof1']['screenshots']),
    'X': {'commit': X, 'subject': git('log', '-1', '--format=%s', X), 'firstParent': X1},
    'regression': {'id': 'B1', 'introducedBy': git('rev-parse', '57f792135'), 'promotedToMainBy': git('rev-parse', '90e749e72'),
                   'description': 'P2.3 57f792135 put will-change: transform on every .toast (Chromium rasterises the success pill on its own layer from a fractional x) and pinned the phone notification column with an inline width (WebKit phone: 358px instead of the CSS 350px, pill 4px to the right). p0-drift README「b 类」, p2.3-b1 README「根因」.'},
    'fix': {'commit': F, 'subject': git('log', '-1', '--format=%s', F), 'deliveredAs': git('rev-parse', '86db4c886'),
            'patchId': patch_id(f'show {F}'), 'patchIdOfDelivered': patch_id('show 86db4c886'),
            'decision': {'taskId': '34bQk0jlytjFYyi4OgLMK', 'evidenceRevision': 1, 'evidenceDigest': 'f20eee2a99a00fa2f7b3d5c827f56b25a465b4c777d81063bc50d88facdd0554', 'verdict': 'CONFIRM', 'document': 'p2.3-b1/README.md'}},
    'premises': {
        'X on origin/main, not a promotion merge': anc(X, main) and len(git('log', '-1', '--format=%P', X).split()) == 1,
        'B1 (57f792135) is an ancestor of X, so every main tree with X carries it': anc('57f792135', X),
        'P2.3 promotion 90e749e72 is an ancestor of X': anc('90e749e72', X),
        'the fix (3ec9cf83d / 86db4c886) is not on origin/main': not anc(F, main) and not anc('86db4c886', main),
        'origin/main at check time': main,
    },
    'trees': {'X+F': {'commit': XF, 'firstParent': git('rev-parse', f'{XF}^1'), 'patchId': patch_id(f'diff {X} {XF}'), 'branch': 'p0d2/d233a6cd0-plus-b1-fix (local, not delivered)'},
              'X^1+F': {'commit': X1F, 'firstParent': git('rev-parse', f'{X1F}^1'), 'patchId': patch_id(f'diff {X1} {X1F}'), 'branch': 'p0d2/e6786d077-plus-b1-fix (local, not delivered)'}},
    'runs': {'X': meta('full-maint-d233a6cd0'), 'X+F': meta('full-maint-xfix-d233a6cd0'), 'X^1+F': meta('full-maint-xfix-e6786d077'),
             'geometry X': meta('diag-d233a6cd0'), 'geometry X+F': meta('diag-xfix-d233a6cd0'), 'geometry X^1+F': meta('diag-xfix-e6786d077')},
    'proof1': {}, 'proof1Others': {}, 'proof2': iso['proof2']['screenshots'],
}
for rel, p in iso['proof1']['screenshots'].items():
    sig = b1[rel]
    record['proof1'][rel] = {**p, 'b1Signature': {'source': 'p2.3-b1/root-cause/toast-box-tip-to-fix-v2.json (B1 tip 77233e226, which already has d233a6cd0, to its fix)',
                                                    'pixels': sig['pixels'], 'insideToastBox': sig['insideToastBox'], 'outsideToastBox': sig['outsideToastBox'], 'clusters': sig['clusters'],
                                                    'introductionPixels': b0[rel]['pixels']},
                             'insideEqualsB1Signature': p['inside'] == sig['insideToastBox'], 'runToRunNoiseOutsideBox': noise[rel]}
others = iso['proof1']['others']
record['proof1Others'] = {'same': sum(v == 'same' for v in others.values()), 'noise': sum(isinstance(v, str) and v.startswith('noise') for v in others.values()),
                          'changed': {k: v for k, v in others.items() if not isinstance(v, str)},
                          'note': 'The only other screenshots X+F changes are the Chromium settings-saved pills, the same B1 fix on the settings page (registered A4 from 4088d37e6, a tree before B1); not part of this exception.'}
assert all(v['insideEqualsB1Signature'] for v in record['proof1'].values())
assert all(v['bytesEqual'] or v['withinNoise'] for v in record['proof2'].values())
assert all(record['premises'][k] for k in record['premises'] if k != 'origin/main at check time')
json.dump(record, open(OUT, 'w'), indent=1, ensure_ascii=False)
open(OUT, 'a').write('\n')
print('ok', OUT)
