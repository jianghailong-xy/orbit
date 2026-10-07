#!/usr/bin/env python3
"""Usage: attribution.py <worktree> <out.json> <out.md>

Same-environment attribution of every screenshot that differs on the project tip (p0-drift README main drift
rule 4 (a)-(f)), from the recorded runs under /var/tmp/p0d2/runs (compare.cjs, p0-drift noise rule):
 (a) project line: da13423d3 -> dd1d197ef -> 4f567434c -> fffcdb532, the first-parent commits whose production
     dist changes (the rest have a dist identical to their first-parent predecessor);
 (b) main first-parent line of dd1d197ef's second parent f86211ec3, from the promotion 162774e52 (dist identical to
     da13423d3) to f86211ec3 (tree identical to dd1d197ef), one run per distinct dist; then, for each main merge that
     changes a screenshot, its single commit X: X^1 unchanged, X changes, X equals the merge;
 (c)/(d) are git facts checked here too; (e) the reference candidate is the run on X's tree; (f) it equals the tip.
Runs on trees before main 2f9cc095f use the P0 tests of the start tip (runner orig, fffcdb532); runs after it use
the same tests with the scene maintenance d2479173b (runner maint): they differ only in wiki-home's wait."""
import json, subprocess, sys
from collections import defaultdict
W, OUT, MD = sys.argv[1:4]
R, D = '/var/tmp/p0d2/runs', '/var/tmp/p0d2/dists'
git = lambda *a: subprocess.check_output(['git', '-C', W, *a], text=True).strip()
full = lambda r: git('rev-parse', r)
dist = lambda label: subprocess.check_output(['sha256sum', f'{D}/{label}.sha256'], text=True).split()[0]
_cache = {}
def compare(a, b):
    if (a, b) not in _cache:
        tmp = f'/var/tmp/p0d2/cmp/{a}__{b}.json'
        subprocess.run(['node', '/var/tmp/p0d2/scripts/compare.cjs', f'{R}/{a}/snapshots', f'{R}/{b}/snapshots', tmp], check=True, stdout=subprocess.DEVNULL)
        _cache[(a, b)] = {r['file']: r for r in json.load(open(tmp))['rows']}
    return _cache[(a, b)]
def cls(a, b, f):
    r = compare(a, b).get(f)
    if not r or r.get('missing'): return 'missing'
    return r['class'] + ('' if r['p0Comparator'] == 'match' else '(fails P0 comparator)')
# Targets: screenshots that differ on the tip from the current expectation.
tip_vs_exp = {r['file']: r for r in json.load(open('/var/tmp/p0d2/cmp/expected__tip.json'))['rows']}
targets = sorted(f for f, r in tip_vs_exp.items() if not r.get('missing') and r['class'] == 'changed')
failing = [f for f in targets if tip_vs_exp[f]['p0Comparator'] != 'match']
# (a) project line
project = [('da13423d3', 'full-orig-da13423d3'), ('dd1d197ef', 'full-maint-dd1d197ef'), ('4f567434c', 'full-maint-4f567434c'), ('fffcdb532', 'full-maint-fffcdb532')]
assert dist('77233e226') == dist('dd1d197ef') and dist('3ec9cf83d') == dist('fffcdb532')
# (b) main first-parent line (distinct dists), with dist twins checked
main = [('162774e52', 'full-orig-da13423d3', ['10c76be5a']), ('aa163019d', 'full-orig-aa163019d', []), ('25cfa3b72', 'full-orig-25cfa3b72', ['85b18b646']),
        ('86c6d2d4d', 'full-orig-86c6d2d4d', ['adb070ff6', 'a0d608432', '383594ee2']), ('4920dab40', 'full-orig-4920dab40', ['ee7de74cc']),
        ('8d2c52f2a', 'full-orig-8d2c52f2a', ['0982d8ed8']), ('dcfb5adf6', 'full-orig-dcfb5adf6', []), ('51f0cdfee', 'full-orig-51f0cdfee', []),
        ('be0f8c22a', 'full-maint-be0f8c22a', []), ('b2e05492f', 'full-maint-b2e05492f', []),
        ('30cf89786', 'full-maint-30cf89786', ['f33589b4c', '71e644742', 'b31de23ca', '17d7c0183']), ('f86211ec3', 'full-maint-dd1d197ef', [])]
assert dist('162774e52') == dist('da13423d3') and dist('f86211ec3') == dist('dd1d197ef')
assert [c[:9] for c in git('rev-list', '--first-parent', '--reverse', 'da13423d3..f86211ec3').split()] == \
    ['5a8edfd62'] + [c for m in main for c in [m[0]] + m[2]] and dist('5a8edfd62') != dist('162774e52'), 'main line'
for c, _, twins in main:
    for t in twins: assert dist(t) == dist(c), (t, c)
for (c1, _, t1), (c2, _, _) in zip(main, main[1:]): assert dist(c1) != dist(c2), (c1, c2)
# Single commits inside the merges that change screenshots: (label, X, X^1 run, X run, merge, merge^1 run, merge run)
singles = [
    ('A6', 'd233a6cd0', 'full-orig-e6786d077', 'full-orig-d233a6cd0', '86c6d2d4d', 'full-orig-25cfa3b72', 'full-orig-86c6d2d4d'),
    ('A7', '6c4e0ac0e', 'full-orig-4920dab40', 'full-orig-6c4e0ac0e', 'dcfb5adf6', 'full-orig-8d2c52f2a', 'full-orig-dcfb5adf6'),
    ('A8', '2f9cc095f', 'full-orig-51f0cdfee', 'full-maint-2f9cc095f', 'be0f8c22a', 'full-orig-51f0cdfee', 'full-maint-be0f8c22a'),
    ('A9', 'a884fda36', 'full-maint-b2e05492f', 'full-maint-a884fda36', '30cf89786', 'full-maint-b2e05492f', 'full-maint-30cf89786')]
assert dist('e3c7eee69') == dist('4920dab40') and dist('903e03fd4') == dist('51f0cdfee') and dist('2a2e889e5') == dist('b2e05492f')
assert dist('2f9cc095f') == dist('be0f8c22a') and dist('a884fda36') == dist('30cf89786')
facts = {}
for label, x, _, _, m, _, _ in singles:
    X = full(x)
    facts[label] = {'X': X, 'subject': git('log', '-1', '--format=%s', X), 'parents': git('log', '-1', '--format=%P', X).split(),
                    'onOriginMain': subprocess.run(['git', '-C', W, 'merge-base', '--is-ancestor', X, 'refs/remotes/origin/main']).returncode == 0,
                    'mergedBy': full(m), 'mergeIsMainFirstParentOf_f86211ec3': full(m) in git('rev-list', '--first-parent', 'da13423d3..f86211ec3').split(),
                    'mergeSubject': git('log', '-1', '--format=%s', m), 'webCommitsInMerge': git('log', '--format=%h %s', f'{m}^1..{m}^2', '--', 'src/web/src', 'src/shared/src').splitlines()}
    assert len(facts[label]['parents']) == 1 and facts[label]['onOriginMain'] and 'Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7' not in facts[label]['subject']
exception = {f'{p}/profile-validation.png' for p in ('chromium-dark-desktop', 'chromium-light-desktop', 'chromium-dark-phone', 'chromium-light-phone', 'webkit-dark-phone', 'webkit-light-phone')}
rows = {}
for f in targets:
    row = {'tipVsExpectation': {k: tip_vs_exp[f][k] for k in ('differentPixels', 'maxChannelDelta', 'p0Comparator')},
           'projectLine': {f'{a[0]}->{b[0]}': cls(a[1], b[1], f) for a, b in zip(project, project[1:])},
           'mainLine': {f'{a[0]}->{b[0]}': cls(a[1], b[1], f) for a, b in zip(main, main[1:])}, 'singles': {}}
    for label, x, x1run, xrun, m, m1run, mrun in singles:
        if not cls(m1run, mrun, f).startswith('changed'): continue
        row['singles'][label] = {'X^1->X': cls(x1run, xrun, f), 'X vs merge': cls(xrun, mrun, f), 'X^1 vs merge^1': cls(x1run, m1run, f)}
    # (e)/(f): the run on the tree of the last X that changed it (rule 7: X + fix for the six B1 screenshots),
    # compared with the interval end f86211ec3 (= dd1d197ef) and with the project tip.
    last = [s for s in singles if s[0] in row['singles']][-1]
    gen = 'full-maint-xfix-d233a6cd0' if f in exception else ('full-maint-d233a6cd0' if last[0] == 'A6' else last[3])
    row['mainCommits'] = [facts[s[0]]['X'] for s in singles if s[0] in row['singles']]
    row['generation'] = {'run': gen, 'vsIntervalEnd f86211ec3': cls(gen, 'full-maint-dd1d197ef', f) if f not in exception else 'n/a (B1 present at the interval end, fixed in the generation tree)',
                         'vsTip fffcdb532': cls(gen, 'full-maint-fffcdb532', f)}
    rows[f] = row
# The wiki scenario's own failure: the original P0 wait for .wk-card, along the drill-down of be0f8c22a.
locator = {}
for commit, run in (('903e03fd4 (X^1 of 2f9cc095f)', 'wiki-orig-903e03fd4'), ('2f9cc095f (X)', 'wiki-orig-2f9cc095f'),
                    ('be0f8c22a (main merge)', 'wiki-orig-be0f8c22a'), ('dd1d197ef (project line)', 'wiki-orig-dd1d197ef')):
    s = json.loads(subprocess.check_output(['python3', '/var/tmp/p0d2/scripts/summarize-report.py', f'{R}/{run}/output/report.json'], text=True))
    locator[commit] = {'run': run, 'passed': s['passed'], 'failed': len(s['unexpected']), 'locators': sorted({u['locator'] for u in s['unexpected']})}
json.dump({'targets': targets, 'failing': failing, 'facts': facts, 'rows': rows, 'wikiLocator': locator}, open(OUT, 'w'), indent=1)
# Markdown: per screenshot, the changepoints
with open(MD, 'w') as md:
    md.write('| 截图 | tip 对照当前期望 | 项目线变化点 | main first-parent 变化点 | 单提交 X（X^1→X / X 与合并） | 生成运行：对区间终点 / 对 tip |\n| --- | --- | --- | --- | --- | --- |\n')
    for f, row in rows.items():
        t = row['tipVsExpectation']
        pl = ', '.join(k for k, v in row['projectLine'].items() if v.startswith('changed')) or '—'
        ml = ', '.join(k.split('->')[1] for k, v in row['mainLine'].items() if v.startswith('changed')) or '—'
        sg = '; '.join(f"{k} `{facts[k]['X'][:9]}`: {v['X^1->X'].split('(')[0]} / {v['X vs merge'].split('(')[0]}" for k, v in row['singles'].items()) or '—'
        g = row['generation']
        md.write(f"| {f} | {t['differentPixels']} px，{'失败' if t['p0Comparator'] != 'match' else '通过'} | {pl} | {ml} | {sg} | {g['run']}：{g['vsIntervalEnd f86211ec3'].split('(')[0].strip()} / {g['vsTip fffcdb532'].split('(')[0]} |\n")
print(len(targets), 'targets,', len(failing), 'failing')
