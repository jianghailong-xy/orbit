#!/usr/bin/env python3
"""Usage: attribution.py <worktree> <out.json> <out.md>

Same-environment attribution of every screenshot that differs on the new base from the current expectation
(p0-drift README main drift rule 4 (a)-(f)), from the recorded runs under $B/runs (compare.cjs, p0-drift noise
rule: changed = fails the P0 comparator, any WebKit pixel differs, or a Chromium pixel differs by more than 4
or in more than 200 pixels; the rest is noise):
 Wiki (A10, main 2ba6765d9):
  (a) project line: f991d2421 -> 1d3cd4c70 (Merge refs/heads/main into the P2.2 second window batch's branch,
      second parent 2ba6765d9), the project tip;
  (b) main first-parent from the merge base c7efa24cb to 2ba6765d9: X^1 7cc52e0cf unchanged, X 2ba6765d9 changed,
      and X is the interval end itself (1d3cd4c70's second parent);
 Settings (A11, main def134095):
  (a) project line: the project tip 1d3cd4c70 (promoted unchanged into main by 3e25635e5, same src/web) is
      unchanged; the new base 4d77d69b7, which this batch takes the project line to, changed;
  (b) main first-parent 3e25635e5..4d77d69b7: X^1 ebf5e6441 unchanged, X def134095 changed, interval end
      4d77d69b7 the same as X;
 (e) the reference candidate is the run on X's tree with the P0 tests plus the one fixture route (runner fix);
     (f) it is compared with the new base's run (and the formal rounds check it later).
"Unchanged" for a predecessor means: passes the P0 comparator against the current expectation and differs from it
only by noise or by a documented below-threshold main change: the six WebKit Settings screenshots whose 8px
scrollbar strip main d233a6cd0 changed (p0-drift-2, A6: it added the Access tokens card below the fold), which
therefore join mainCommits of those six entries; and P3.2's eleven accepted below-threshold differences
(p3.2-accepted), which no step here touches.
Runs on trees without the share request use the original P0 tests (runner orig = 4d77d69b7's tests); the
fixture-only comparisons (orig vs fix on one tree) show what the route changes in the screenshots."""
import json, os, subprocess, sys
W, OUT, MD = sys.argv[1:4]
B = '/mnt/data/tmp/34cFgyWHIYDslABFPloEM'
R, D, C = f'{B}/runs', f'{B}/dists', f'{B}/cmp'
os.makedirs(C, exist_ok=True)
git = lambda *a: subprocess.check_output(['git', '-C', W, *a], text=True).strip()
full = lambda r: git('rev-parse', r)
dist = lambda label: subprocess.check_output(['sha256sum', f'{D}/{label}.sha256'], text=True).split()[0]
snap = lambda label: {'expected': f'{B}/expected/base-start', 'registered': f'{B}/checks/final-round-1/expected-screenshots-assembled'}.get(label, f'{R}/{label}/snapshots')
_cache = {}
def compare(a, b):
    if (a, b) not in _cache:
        out = f'{C}/{a}__{b}.json'
        if not os.path.exists(out):
            subprocess.run(['node', f'{B}/scripts/compare.cjs', snap(a), snap(b), out], check=True, stdout=subprocess.DEVNULL)
        _cache[(a, b)] = {r['file']: r for r in json.load(open(out))['rows']}
    return _cache[(a, b)]
def cls(a, b, f):
    r = compare(a, b).get(f)
    if not r or r.get('missing'): return 'missing'
    return r['class'] + ('' if r['p0Comparator'] == 'match' else ' (fails P0 comparator)')
def px(a, b, f):
    r = compare(a, b).get(f) or {}
    return {k: r.get(k) for k in ('differentPixels', 'maxChannelDelta', 'p0Comparator', 'box')}
for label in ('full-orig-f991d2421', 'full-orig-1d3cd4c70', 'full-orig-7cc52e0cf', 'full-orig-2ba6765d9', 'full-fix-2ba6765d9',
              'full-fix-ebf5e6441', 'full-fix-def134095', 'full-fix-base', 'full-orig-base', 'full-fix-1d3cd4c70', 'full-fix-base2', 'full-orig-base2', 'full-fix-base3', 'full-orig-base3'):
    m = json.load(open(f'{R}/{label}/meta.json'))
    assert m.get('environment') == 'p0.2' and m.get('screenshots') == 252, (label, m.get('environment'), m.get('screenshots'))
# Targets: screenshots of the new base (P0 tests plus the route) that differ from the current expectation.
base_vs_exp = compare('expected', 'full-fix-base')
targets = sorted(f for f, r in base_vs_exp.items() if not r.get('missing') and r['class'] == 'changed')
failing = [f for f in targets if base_vs_exp[f]['p0Comparator'] != 'match']
below = [f for f, r in base_vs_exp.items() if not r.get('missing') and r['p0Comparator'] == 'match' and r['class'] == 'changed']
# Git facts for (b)-(d).
X = {'A10': full('2ba6765d9'), 'A11': full('def134095')}
facts = {}
for k, x in X.items():
    parents = git('log', '-1', '--format=%P', x).split()
    facts[k] = {'X': x, 'subject': git('log', '-1', '--format=%s', x), 'parents': parents, 'X^1': parents[0],
                'onOriginMain': subprocess.run(['git', '-C', W, 'merge-base', '--is-ancestor', x, 'refs/remotes/origin/main']).returncode == 0,
                'onMainFirstParent': x in git('rev-list', '--first-parent', 'refs/remotes/origin/main').split(),
                'webFiles': git('show', '--format=', '--name-only', x, '--', 'src/web/src', 'src/shared/src').splitlines()}
    assert len(parents) == 1 and facts[k]['onOriginMain'] and facts[k]['onMainFirstParent']
    assert 'Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7' not in facts[k]['subject']
facts['A10']['projectLineMerge'] = {'commit': full('1d3cd4c70'), 'parents': git('log', '-1', '--format=%P', '1d3cd4c70').split(),
                                    'subject': git('log', '-1', '--format=%s', '1d3cd4c70'),
                                    'mainInterval': git('log', '--first-parent', '--format=%h %s', 'f991d2421..2ba6765d9').splitlines()}
assert facts['A10']['projectLineMerge']['parents'] == [full('f991d2421'), X['A10']]
facts['A11']['mainInterval'] = git('log', '--first-parent', '--format=%h %s', '3e25635e5^..4d77d69b7').splitlines()
facts['A11']['promotion'] = {'commit': full('3e25635e5'), 'parents': git('log', '-1', '--format=%P', '3e25635e5').split(),
                             'srcWebEqualsProjectTip': git('rev-parse', '3e25635e5:src/web') == git('rev-parse', '1d3cd4c70:src/web'),
                             'distEqualsProjectTip': dist('3e25635e5') == dist('1d3cd4c70')}
assert facts['A11']['promotion']['parents'][1] == full('1d3cd4c70')
# Documented below-threshold differences of the current expectation (no P0 comparator failure).
SCROLLBAR_A6 = {f'webkit-{t}-{s}/{n}' for t in ('light', 'dark') for s, n in (('desktop', 'settings.png'), ('desktop', 'settings-saved.png'), ('phone', 'settings.png'))}
P32 = {'chromium-dark-desktop/task-action-menu.png', 'chromium-dark-phone/task-action-menu.png', 'webkit-dark-desktop/task-action-menu.png',
       'webkit-dark-phone/task-action-menu.png', 'webkit-dark-phone/task-detail.png', 'webkit-dark-phone/task-action-hover.png',
       'webkit-dark-phone/task-action-focus.png', 'webkit-dark-desktop/breakpoint-599-dialog.png', 'webkit-dark-desktop/breakpoint-601-dialog.png',
       'webkit-light-desktop/breakpoint-599-dialog.png', 'webkit-light-desktop/breakpoint-601-dialog.png'}
def unchanged(a, b, f):
    """Not a change in the attribution sense: same or noise, or (A6 scrollbar) a documented below-threshold difference
    confined to the right 8px strip that passes the P0 comparator."""
    r = compare(a, b).get(f) or {}
    if r.get('class') in ('same', 'noise'): return True
    box = r.get('box') or {}
    return (f in SCROLLBAR_A6 and r.get('p0Comparator') == 'match' and box.get('width') == 8
            and box.get('x') in (1264, 1272, 382))
# Per screenshot.
rows = {}
for f in targets:
    name = f.split('/')[1]
    row = {'baseVsExpectation': px('expected', 'full-fix-base', f)}
    if name.startswith(('wiki-', 'breakpoint-959-wiki', 'breakpoint-961-wiki')):
        row['change'] = 'A10'
        row['projectLine'] = {'expected vs f991d2421': cls('expected', 'full-orig-f991d2421', f),
                              'f991d2421 -> 1d3cd4c70': cls('full-orig-f991d2421', 'full-orig-1d3cd4c70', f)}
        row['mainLine'] = {'expected vs X^1 7cc52e0cf': cls('expected', 'full-orig-7cc52e0cf', f),
                           'X^1 7cc52e0cf -> X 2ba6765d9': cls('full-orig-7cc52e0cf', 'full-orig-2ba6765d9', f),
                           'X 2ba6765d9 vs project line 1d3cd4c70': cls('full-orig-2ba6765d9', 'full-orig-1d3cd4c70', f)}
        row['fixture'] = {'X orig vs X fix': cls('full-orig-2ba6765d9', 'full-fix-2ba6765d9', f),
                          '1d3cd4c70 orig vs fix': cls('full-orig-1d3cd4c70', 'full-fix-1d3cd4c70', f),
                          'base orig vs fix': cls('full-orig-base', 'full-fix-base', f)}
        row['generation'] = {'run': 'full-fix-2ba6765d9', 'vs new base 4d77d69b7': cls('full-fix-2ba6765d9', 'full-fix-base', f),
                             'vs project tip 1d3cd4c70': cls('full-fix-2ba6765d9', 'full-fix-1d3cd4c70', f)}
        ok = (unchanged('expected', 'full-orig-f991d2421', f) and row['projectLine']['f991d2421 -> 1d3cd4c70'].endswith('(fails P0 comparator)')
              and unchanged('expected', 'full-orig-7cc52e0cf', f) and row['mainLine']['X^1 7cc52e0cf -> X 2ba6765d9'].endswith('(fails P0 comparator)')
              and unchanged('full-orig-2ba6765d9', 'full-orig-1d3cd4c70', f)
              and unchanged('full-fix-2ba6765d9', 'full-fix-base', f) and unchanged('full-orig-2ba6765d9', 'full-fix-2ba6765d9', f))
        row['mainCommits'] = ['2ba6765d9']
    elif name in ('settings.png', 'settings-saved.png'):
        row['change'] = 'A11'
        row['projectLine'] = {'expected vs project tip 1d3cd4c70': cls('expected', 'full-orig-1d3cd4c70', f),
                              'project tip 1d3cd4c70 -> new base 4d77d69b7': cls('full-orig-1d3cd4c70', 'full-orig-base', f)}
        row['mainLine'] = {'expected vs X^1 ebf5e6441': cls('expected', 'full-fix-ebf5e6441', f),
                           'X^1 ebf5e6441 -> X def134095': cls('full-fix-ebf5e6441', 'full-fix-def134095', f),
                           'X def134095 vs interval end 4d77d69b7': cls('full-fix-def134095', 'full-fix-base', f)}
        row['fixture'] = {'base orig vs fix': cls('full-orig-base', 'full-fix-base', f)}
        row['generation'] = {'run': 'full-fix-def134095', 'vs new base 4d77d69b7': cls('full-fix-def134095', 'full-fix-base', f)}
        ok = (unchanged('expected', 'full-orig-1d3cd4c70', f)
              and row['projectLine']['project tip 1d3cd4c70 -> new base 4d77d69b7'].endswith('(fails P0 comparator)')
              and unchanged('expected', 'full-fix-ebf5e6441', f) and row['mainLine']['X^1 ebf5e6441 -> X def134095'].endswith('(fails P0 comparator)')
              and unchanged('full-fix-def134095', 'full-fix-base', f) and unchanged('full-orig-base', 'full-fix-base', f))
        row['mainCommits'] = ['d233a6cd0', 'def134095'] if f in SCROLLBAR_A6 else ['def134095']
        if f in SCROLLBAR_A6:
            row['documentedBelowThreshold'] = {'change': 'A6 d233a6cd0 (p0-drift-2): WebKit 8px scrollbar strip',
                                               'expected vs X^1': px('expected', 'full-fix-ebf5e6441', f)}
    elif f in P32 and base_vs_exp[f]['p0Comparator'] == 'match':
        row['change'] = None
        row['documentedBelowThreshold'] = {'change': 'P3.2 accepted below-threshold difference (p3.2-accepted), not this batch',
                                           'X^1 7cc52e0cf': cls('expected', 'full-orig-7cc52e0cf', f), 'base': cls('expected', 'full-fix-base', f)}
        ok = None
    else:
        row['change'] = None
        ok = False
    # After the rebases onto origin/main 93ab20b8c and then 075b7a6c8: the same screenshot on each rebased base, and
    # against the expectation assembled after both registrations (the first formal round's globalSetup copy).
    if ok:
        row['rebasedBase'] = {'4d77d69b7 vs 93ab20b8c': cls('full-fix-base', 'full-fix-base2', f),
                              'registered expectation vs 93ab20b8c': cls('registered', 'full-fix-base2', f),
                              '93ab20b8c vs 075b7a6c8': cls('full-fix-base2', 'full-fix-base3', f),
                              'registered expectation vs 075b7a6c8': cls('registered', 'full-fix-base3', f)}
        ok = (ok and unchanged('full-fix-base', 'full-fix-base2', f) and compare('registered', 'full-fix-base2')[f]['p0Comparator'] == 'match'
              and unchanged('full-fix-base2', 'full-fix-base3', f) and compare('registered', 'full-fix-base3')[f]['p0Comparator'] == 'match')
    row['attributed'] = ok
    rows[f] = row
unattributed = [f for f, r in rows.items() if r['attributed'] is False]
documented = [f for f, r in rows.items() if r['attributed'] is None]
json.dump({'targets': targets, 'failing': failing, 'belowThresholdChanged': below, 'unattributed': unattributed, 'documentedNotThisBatch': documented,
           'facts': facts, 'rows': rows},
          open(OUT, 'w'), indent=1, ensure_ascii=False)
open(OUT, 'a').write('\n')
short = lambda v: v.replace(' (fails P0 comparator)', '，比较器失败')
with open(MD, 'w') as md:
    md.write('| 截图 | 新基础对照当前期望 | 归因 | 项目线 | main first-parent（X^1 / X^1→X / X 与区间终点） | 补固定响应前后 | 生成运行对新基础 |\n| --- | --- | --- | --- | --- | --- | --- |\n')
    for f, row in rows.items():
        t = row['baseVsExpectation']
        pl = ' / '.join(short(v) for v in row.get('projectLine', {}).values())
        ml = ' / '.join(short(v) for v in row.get('mainLine', {}).values())
        fx = ' / '.join(short(v) for v in row.get('fixture', {}).values())
        g = row.get('generation', {})
        if row['attributed'] is None:
            md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，通过 | 不属本批：P3.2 已记录的低于阈值差异 | — | X^1 `7cc52e0cf` 对照当前期望同样是 {short(row['documentedBelowThreshold']['X^1 7cc52e0cf'])} | — | — |\n")
            continue
        note = '；X^1 与当前期望只差 A6 `d233a6cd0` 的滚动条（低于阈值）' if 'documentedBelowThreshold' in row else ''
        md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，{'失败' if t['p0Comparator'] != 'match' else '通过'} | "
                 f"{row['change'] or '—'} `{X[row['change']][:9] if row['change'] else ''}`{note} | {pl} | {ml} | {fx} | {g.get('run', '')}：{short(g.get('vs new base 4d77d69b7', ''))} |\n")
print(json.dumps({'targets': len(targets), 'failing': len(failing), 'belowThresholdChanged': len(below), 'attributed': sum(1 for r in rows.values() if r['attributed']),
                  'documentedNotThisBatch': len(documented), 'unattributed': unattributed}))
