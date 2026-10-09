#!/usr/bin/env python3
"""Usage: attribution.py <worktree> <out.json> <out.md>

Same-environment attribution (p0-drift README, main drift rule 4 (a)-(f)) of every screenshot that differs on the new
base 17980cb7c from the expectation assembled at the start (expected-start: 87 P0.2 originals, 143 main drift
references, 22 accepted migration differences), from the recorded runs under $B/runs. compare.cjs classifies each pair
with the p0-drift noise rule (changed = fails the P0 comparator, any WebKit pixel differs, or a Chromium pixel differs
by more than 4 or in more than 200 pixels; the rest is noise). Every run is an update-mode full matrix (pages, states,
breakpoints: 80 tests, 252 screenshots) of the tip's P0 tests (runner tip = 17980cb7c) on a lean build of the tree.

 A12 Infrastructure sidebar (desktop):
  (a) project line first-parent: fce12bc2a (unchanged) -> cbe6a6635 Merge refs/heads/project/34aithLozDanSv6nq0IAi
      into refs/heads/main (changed), a main commit the project line holds directly (P4.3a was rebased onto main
      19c760ae4, whose first-parent chain runs through it); from cbe6a6635 to ffae02edf (the last project-line commit
      before 17980cb7c: P4.3a, P4.3b, two merges of main that bring no Web input) nothing changes;
  (b) inside the merge, its second parent's first-parent line (merge base 6c9cebd4d .. 6baf92736): 33e0e2e09 changes the
      sidebar against its parent db69d833b, and the line's end 6baf92736 builds the same dist as cbe6a6635;
  (e) reference: the run on cbe6a6635's tree (the last of mainCommits [.., 33e0e2e09, cbe6a6635]).
 A13 turn foot (main 3960c19c2) and A14 composer fade (main 9d3751ec2), session page (every size):
  (a) project line: ffae02edf (unchanged) -> 17980cb7c Merge refs/heads/main (87351bf9a) (changed);
  (b) main first-parent from the merge base 4085437ff (its dist is cbe6a6635's) to 87351bf9a, every distinct dist run:
      bab3256a7, 489021bfa, a74ecb43b, d976df772 (= 3960c19c2^1), 3960c19c2, 0a887da2c, 51c5c8eeb (= 9d3751ec2^1),
      9d3751ec2, 87351bf9a (c8a431304, 384b7f86a, 35e6fe726 build 9d3751ec2's dist; 435729f1b builds 87351bf9a's);
  (e) reference: the run on the last attributed commit's tree.
"Unchanged" means same or noise, or one of the documented below-threshold differences of the current expectation
(P3.2's eleven, p3.2-accepted; the WebKit scroll-lock batch's three light-phone screenshots, webkit-scroll-lock-accepted)
when it passes the P0 comparator."""
import json, os, subprocess, sys
W, OUT, MD = sys.argv[1:4]
B = '/mnt/data/tmp/34cswWfvNasFTq8kDM0Q4'
R, D, C = f'{B}/runs', f'{B}/dists', f'{B}/cmp'
os.makedirs(C, exist_ok=True)
git = lambda *a: subprocess.check_output(['git', '-C', W, *a], text=True).strip()
full = lambda r: git('rev-parse', r)
dist = lambda label: subprocess.check_output(['sha256sum', f'{D}/{label}.sha256'], text=True).split()[0]
snap = lambda label: {'expected': f'{B}/expected-start', 'registered': f'{B}/expected-registered'}.get(label, f'{R}/{label}/snapshots' if label.startswith('sp-old-') else f'{R}/full-{label}/snapshots')
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
RUNS = ['base', 'fce12bc2a', 'cbe6a6635', 'abc0a4cfa', 'ffae02edf', 'bab3256a7', '489021bfa', 'a74ecb43b',
        'd976df772', '3960c19c2', '0a887da2c', '51c5c8eeb', '9d3751ec2', '87351bf9a']
# The drill-down trees inside cbe6a6635 (10-07, before P4.1 reached main): the tip's settings/profile scenarios wait for
# P4.1's .orbit-card, so those two tests fail there (220 screenshots); db69d833b's own P0 tests take them (sp-old-*).
PARTIAL = {'db69d833b': 220, '33e0e2e09': 220}
meta = {}
for label in RUNS + list(PARTIAL):
    m = json.load(open(f'{R}/full-{label}/meta.json'))
    assert m.get('environment') == 'p0.2' and m.get('screenshots') == PARTIAL.get(label, 252) and m.get('exit') == (1 if label in PARTIAL else 0), (label, m.get('environment'), m.get('screenshots'), m.get('exit'))
    meta[label] = {'commit': m['commit'], 'stats': m['stats'], 'unhandled': m['evidence']['unhandled'], 'pageErrors': m['evidence']['withPageErrors'],
                   'dist': dist(label)}
# Documented below-threshold differences of the current expectation.
P32 = {'chromium-dark-desktop/task-action-menu.png', 'chromium-dark-phone/task-action-menu.png', 'webkit-dark-desktop/task-action-menu.png',
       'webkit-dark-phone/task-action-menu.png', 'webkit-dark-phone/task-detail.png', 'webkit-dark-phone/task-action-hover.png',
       'webkit-dark-phone/task-action-focus.png', 'webkit-dark-desktop/breakpoint-599-dialog.png', 'webkit-dark-desktop/breakpoint-601-dialog.png',
       'webkit-light-desktop/breakpoint-599-dialog.png', 'webkit-light-desktop/breakpoint-601-dialog.png'}
SCROLL_LOCK = {f'webkit-light-phone/{n}' for n in ('settings-saved.png', 'profile-validation.png', 'notification-error.png')}
def unchanged(a, b, f):
    r = compare(a, b).get(f) or {}
    if r.get('class') in ('same', 'noise'): return True
    return a == 'expected' and f in (P32 | SCROLL_LOCK) and r.get('p0Comparator') == 'match'
changed = lambda a, b, f: (compare(a, b).get(f) or {}).get('class') == 'changed'
fails = lambda a, b, f: (compare(a, b).get(f) or {}).get('p0Comparator', 'match') != 'match'

base_vs_exp = compare('expected', 'base')
targets = sorted(f for f, r in base_vs_exp.items() if not r.get('missing') and r['class'] == 'changed')
failing = sorted(f for f in targets if base_vs_exp[f]['p0Comparator'] != 'match')
below = sorted(f for f in targets if base_vs_exp[f]['p0Comparator'] == 'match')

# Git facts.
def commit_facts(c):
    x = full(c)
    return {'commit': x, 'subject': git('log', '-1', '--format=%s', x), 'parents': git('log', '-1', '--format=%P', x).split(),
            'onOriginMain': subprocess.run(['git', '-C', W, 'merge-base', '--is-ancestor', x, 'refs/remotes/origin/main']).returncode == 0,
            'onOriginMainFirstParent': x in git('rev-list', '--first-parent', 'refs/remotes/origin/main').split(),
            'onProjectLineFirstParent': x in git('rev-list', '--first-parent', '17980cb7c').split(),
            'promotionOfThisProject': 'Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7' in git('log', '-1', '--format=%s', x)}
facts = {'A12': {'X': commit_facts('cbe6a6635'), 'productCommit': commit_facts('33e0e2e09'),
                 'mergeSecondParentLine': git('log', '--first-parent', '--format=%h %s', 'fce12bc2a..6baf92736').splitlines(),
                 'mergeBase': full('6c9cebd4d') if git('merge-base', 'fce12bc2a', '6baf92736') == full('6c9cebd4d') else None,
                 'productCommitWebFiles': git('show', '--format=', '--name-only', '33e0e2e09', '--', 'src/web/src', 'src/shared/src').splitlines(),
                 'distEqual': {'cbe6a6635 = 6baf92736 (the merged line end)': dist('cbe6a6635') == dist('6baf92736'),
                               'cbe6a6635 = 4085437ff (merge base of 17980cb7c)': dist('cbe6a6635') == dist('4085437ff')},
                 'projectLineInterval': git('log', '--first-parent', '--format=%h %s', 'cbe6a6635..ffae02edf').splitlines()},
         'A13': {'X': commit_facts('3960c19c2'), 'webFiles': git('show', '--format=', '--name-only', '3960c19c2', '--', 'src/web/src', 'src/shared/src').splitlines()},
         'A14': {'X': commit_facts('9d3751ec2'), 'webFiles': git('show', '--format=', '--name-only', '9d3751ec2', '--', 'src/web/src', 'src/shared/src').splitlines()},
         'mainInterval': git('log', '--first-parent', '--format=%h %s', '4085437ff..87351bf9a').splitlines(),
         'projectLineMerge': commit_facts('17980cb7c'),
         'sameDist': {'d976df772 = a74ecb43b': dist('d976df772') == dist('a74ecb43b'), '51c5c8eeb = 0a887da2c': dist('51c5c8eeb') == dist('0a887da2c'),
                      'c8a431304 = 384b7f86a = 35e6fe726 = 9d3751ec2': len({dist(c) for c in ('c8a431304', '384b7f86a', '35e6fe726', '9d3751ec2')}) == 1,
                      '435729f1b = 87351bf9a': dist('435729f1b') == dist('87351bf9a')}}
assert facts['A12']['X']['parents'] == [full('fce12bc2a'), full('6baf92736')] and facts['A12']['X']['onProjectLineFirstParent']
assert facts['projectLineMerge']['parents'] == [full('ffae02edf'), full('87351bf9a')]
for k in ('A12', 'A13', 'A14'):
    assert facts[k]['X']['onOriginMain'] and not facts[k]['X']['promotionOfThisProject'], k
for k in ('A13', 'A14'):
    assert facts[k]['X']['onOriginMainFirstParent'] and len(facts[k]['X']['parents']) == 1, k
assert all(facts['A12']['distEqual'].values()) and all(facts['sameDist'].values()), (facts['A12']['distEqual'], facts['sameDist'])

for label in ('sp-old-db69d833b', 'sp-old-33e0e2e09'):
    m = json.load(open(f'{R}/{label}/meta.json'))
    assert m.get('environment') == 'p0.2' and m.get('screenshots') == 32 and m.get('exit') == 0, label
    meta[label] = {'commit': m['commit'], 'stats': m['stats'], 'unhandled': m['evidence']['unhandled'], 'pageErrors': m['evidence']['withPageErrors'], 'runner': m['runnerCommit']}
T_CHAIN = ['cbe6a6635', 'bab3256a7', '489021bfa', 'a74ecb43b', 'd976df772', '3960c19c2', '0a887da2c', '51c5c8eeb', '9d3751ec2', '87351bf9a']
SP = ('settings.png', 'settings-saved.png', 'profile.png', 'profile-validation.png')
drill_pair = lambda f: ('sp-old-db69d833b', 'sp-old-33e0e2e09') if f.split('/')[1] in SP else ('db69d833b', '33e0e2e09')
sidebar = json.load(open(f'{C}/sidebar-column__33e0e2e09__cbe6a6635.json'))
rows = {}
for f in targets:
    row = {'baseVsExpectation': px('expected', 'base', f)}
    proj, name = f.split('/')
    # A12: does the sidebar change happen at cbe6a6635 (against fce12bc2a, which reproduces the expectation)?
    a12 = changed('fce12bc2a', 'cbe6a6635', f)
    # Main interval of 17980cb7c: where does the screenshot change between consecutive distinct dists?
    steps = {f'{a} -> {b}': cls(a, b, f) for a, b in zip(T_CHAIN, T_CHAIN[1:])}
    t_points = [b for a, b in zip(T_CHAIN, T_CHAIN[1:]) if changed(a, b, f)]
    row['projectLine'] = {'expected vs fce12bc2a': cls('expected', 'fce12bc2a', f), 'fce12bc2a -> cbe6a6635': cls('fce12bc2a', 'cbe6a6635', f),
                          'cbe6a6635 -> ffae02edf': cls('cbe6a6635', 'ffae02edf', f), 'ffae02edf -> 17980cb7c': cls('ffae02edf', 'base', f)}
    row['mainInterval'] = steps
    row['changePoints'] = (['cbe6a6635'] if a12 else []) + t_points
    a, b = drill_pair(f)
    row['drill'] = {f'{a} -> {b}': cls(a, b, f)}
    if f in sidebar:
        row['drill']['33e0e2e09 vs cbe6a6635, sidebar column x < 272'] = sidebar[f]['sidebarColumnPixels']
    change, mains = [], []
    if a12:
        change.append('A12'); mains += ['33e0e2e09', 'cbe6a6635']
    if '3960c19c2' in t_points:
        change.append('A13'); mains.append('3960c19c2')
    if '9d3751ec2' in t_points:
        change.append('A14'); mains.append('9d3751ec2')
    row['change'], row['mainCommits'] = change, mains
    gen = mains[-1] if mains else None
    row['generatedFrom'] = gen
    ok = bool(change) and set(row['changePoints']) <= {'cbe6a6635', '3960c19c2', '9d3751ec2'}
    # (a)/(b): predecessors unchanged; the change at X; nothing else on the way to the new base.
    # P4.3b (abc0a4cfa -> ffae02edf) moves the WebKit desktop full-screen graph by 9 and 17 pixels of one level, under the
    # comparator's threshold, as its own same-commit evidence recorded; a migration difference, not registered anywhere.
    P43B = ('webkit-dark-desktop/project-graph-fullscreen.png', 'webkit-light-desktop/project-graph-fullscreen.png')
    if f in P43B:
        row['documentedBelowThreshold'] = {'change': 'P4.3b (abc0a4cfa -> ffae02edf): WebKit 1-level pixels on the full-screen graph, under the threshold',
                                           'cbe6a6635 -> abc0a4cfa': cls('cbe6a6635', 'abc0a4cfa', f), 'abc0a4cfa -> ffae02edf': px('abc0a4cfa', 'ffae02edf', f)}
    ok = ok and unchanged('expected', 'fce12bc2a', f) and (unchanged('cbe6a6635', 'ffae02edf', f) or (f in P43B and not fails('cbe6a6635', 'ffae02edf', f)
                                                                                                   and unchanged('cbe6a6635', 'abc0a4cfa', f)))
    if a12:
        ok = ok and fails('fce12bc2a', 'cbe6a6635', f) and fails(a, b, f)
        # 33e0e2e09's sidebar column is cbe6a6635's: identical, but for the WebKit scroll lock's (0,0) pixel
        # (9f2f7e9a0, in cbe6a6635's tree and not in 33e0e2e09's) on the six WebKit desktop screenshots taken after a toast.
        ok = ok and sidebar[f]['sidebarColumnPixels'] <= (1 if f.startswith('webkit-') else 0)
    if t_points:
        ok = ok and changed('ffae02edf', 'base', f) and fails('ffae02edf', 'base', f)
        ok = ok and fails('d976df772', '3960c19c2', f) and unchanged('a74ecb43b', 'd976df772', f) and unchanged('cbe6a6635', 'a74ecb43b', f)
        ok = ok and unchanged('3960c19c2', '0a887da2c', f) and unchanged('0a887da2c', '51c5c8eeb', f) and changed('51c5c8eeb', '9d3751ec2', f) and unchanged('9d3751ec2', '87351bf9a', f)
    else:
        ok = ok and unchanged('ffae02edf', 'base', f)
    # (e)/(f): the generation run against the new base.
    if gen:
        row['generation'] = {'run': f'full-{gen}', 'vs new base 17980cb7c': cls(gen, 'base', f), 'vs main 87351bf9a': cls(gen, '87351bf9a', f)}
        # The reference is generated on the last attributed commit; the new base differs from it only by noise or by
        # P4.3b's documented 1-level WebKit pixels on the full-screen graph (abc0a4cfa -> ffae02edf).
        p43b = f in P43B
        ok = ok and (unchanged(gen, 'base', f) or (p43b and not fails(gen, 'base', f))) and (unchanged(gen, '87351bf9a', f) or not fails(gen, '87351bf9a', f))
    row['registered'] = {'vs new base 17980cb7c': cls('registered', 'base', f)}
    ok = ok and not fails('registered', 'base', f)
    row['attributed'] = ok
    rows[f] = row
documented = sorted(f for f in below if f in (P32 | SCROLL_LOCK))
unattributed = sorted(f for f, r in rows.items() if not r['attributed'] and f not in documented)
summary = {'targets': len(targets), 'failing': len(failing), 'belowThresholdChanged': len(below), 'documentedNotThisBatch': documented,
           'attributed': sum(1 for r in rows.values() if r['attributed']), 'unattributed': unattributed,
           'byChange': {}}
for f, r in rows.items():
    if r['attributed']:
        summary['byChange'].setdefault('+'.join(r['change']), []).append(f)
json.dump({'summary': summary, 'meta': meta, 'facts': facts, 'rows': rows}, open(OUT, 'w'), indent=1, ensure_ascii=False)
open(OUT, 'a').write('\n')
short = lambda v: v.replace(' (fails P0 comparator)', '，比较器失败').replace('same', '相同').replace('noise', '噪声').replace('changed', '变化')
with open(MD, 'w') as md:
    md.write('| 截图 | 新基础对照当前期望 | 归因 | 项目线 fce12bc2a→cbe6a6635 / cbe6a6635→ffae02edf / ffae02edf→17980cb7c | main 区间的变化点 | 下钻（cbe6a6635 合入线：db69d833b→33e0e2e09；侧栏列对照 cbe6a6635） | 生成运行对新基础 |\n| --- | --- | --- | --- | --- | --- | --- |\n')
    for f, row in rows.items():
        t = row['baseVsExpectation']
        if f in documented:
            md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，通过 | 不属本批：已记录的低于阈值差异 | — | — | — | — |\n")
            continue
        pl = ' / '.join(short(row['projectLine'][k]) for k in ('fce12bc2a -> cbe6a6635', 'cbe6a6635 -> ffae02edf', 'ffae02edf -> 17980cb7c'))
        tp = ', '.join(p for p in row['changePoints'] if p != 'cbe6a6635') or '—'
        g = row.get('generation', {})
        md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，{'失败' if t['p0Comparator'] != 'match' else '通过'} | "
                 f"{'+'.join(row['change']) or '—'}{'' if row['attributed'] else '（未归因）'} | {pl} | {tp} | {'; '.join(f'{k}：{short(v) if isinstance(v, str) else v}' for k, v in row['drill'].items())} | "
                 f"{g.get('run', '')}：{short(g.get('vs new base 17980cb7c', ''))} |\n")
print(json.dumps({k: (len(v) if isinstance(v, list) else v) for k, v in summary.items() if k != 'byChange'} | {'byChange': {k: len(v) for k, v in summary['byChange'].items()}}))
