#!/usr/bin/env python3
"""Usage: attribution.py <worktree> <out.json> <out.md>

Same-environment attribution (p0-drift README, main drift rule 4 (a)-(f)) of every screenshot that differs on the new
base bcf00ab95 (origin/main, the merge that promoted project tip 951882866; the same tree) from the expectation assembled
at the start (expected-start: 44 P0.2 originals, 183 main drift references, 25 accepted migration differences), from the
recorded runs under $B/runs. compare.cjs classifies each pair with the p0-drift noise rule (changed = fails the P0
comparator, any WebKit pixel differs, or a Chromium pixel differs by more than 4 or in more than 200 pixels; the rest is
noise). Every run is an update-mode full matrix (pages, states, breakpoints: 80 tests, 252 screenshots) of the tip's P0
tests (runner tip = bcf00ab95) on a lean build of the tree.

Project line first-parent since batch 7 (7a5a6880a), every tree run (a tree whose Web build inputs equal another's is run
once, under that label):
  baad1a557 Merge refs/heads/main (ec881f633)   [Web inputs = ec881f633: run full-ec881f633]
  cb35d126a Merge refs/heads/main (46e28aaa3)   [tree = 46e28aaa3: run full-46e28aaa3]
  904a0dcca..d580e572d P4.4 (migration)         [run full-d580e572d]
  2fcd654d8 Merge origin/main (c26b69643)       [run full-2fcd654d8]
  d354b64c5 Merge refs/heads/main (9498167b9)   [run full-d354b64c5]
  3a65947f9..951882866 tasks toolbar, Select/Close (migration) [tree 951882866 = bcf00ab95: run full-base]
Main first-parent intervals the three merges absorb (b), each run at X^1, X and the interval end:
  A15 ec881f633 .. 46e28aaa3: X^1 56c21bdd2, X 46e28aaa3 (Merge refs/heads/project/34d0oH4R6LErqqsox7wYv into main,
      which brings in 83671b995 feat(clients): the session list shows the server's recap, behind one account switch);
      the interval ends at X. Inside: 92ce415e9 (= f6bf9f496's Web inputs, the merge base) -> 83671b995; the line's end
      43e0eadeb has 83671b995's Web inputs.
  A16 46e28aaa3 .. c26b69643: X^1 46e28aaa3, X e69765706 (Merge refs/heads/project/34ccMg4EoSorpVooMC4kg into main,
      which brings in T7: 3a3c58c1f feat(web): sessions, tasks and workspaces pick the engine, then a provider it runs,
      and e2e5196f0 fix(web): the task pin lists account pools; the engine list fits its names), end c26b69643
      (e223d8eed changes no Web input). Inside: c5447f6bf (= 56c21bdd2's Web inputs) -> 50147192e (the T7 branch merged
      into the provider-engine project; df0bef43d, the T7 line's end, has its Web inputs); on the T7 line a68f07f74 ->
      3a3c58c1f -> e2e5196f0.
  A17 c26b69643 .. 9498167b9: X^1 c26b69643, X d2e295917 (feat(web): a worked-for row at the head of every turn, over
      its own output), end 9498167b9.
"Unchanged" means same or noise, or, against the expectation, one of the documented below-threshold differences of the
current expectation (BELOW) when it passes the P0 comparator."""
import json, os, subprocess, sys
W, OUT, MD = sys.argv[1:4]
B = '/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG'
R, D, C = f'{B}/runs', f'{B}/dists', f'{B}/cmp'
os.makedirs(C, exist_ok=True)
git = lambda *a: subprocess.check_output(['git', '-C', W, *a], text=True).strip()
full = lambda r: git('rev-parse', r)
dist = lambda label: subprocess.check_output(['sha256sum', f'{D}/{label}.sha256'], text=True).split()[0]
snap = lambda label: {'expected': f'{B}/expected-start', 'registered': f'{B}/expected-registered'}.get(label, f'{R}/full-{label}/snapshots')
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
PROJECT = ['ec881f633', '46e28aaa3', 'd580e572d', '2fcd654d8', 'd354b64c5', 'base']
PROJECT_NAMES = {'ec881f633': 'baad1a557', '46e28aaa3': 'cb35d126a', 'd580e572d': 'd580e572d', '2fcd654d8': '2fcd654d8',
                 'd354b64c5': 'd354b64c5', 'base': '951882866 (= bcf00ab95)'}
MAIN = ['ec881f633', '56c21bdd2', '46e28aaa3', 'e69765706', 'c26b69643', 'd2e295917', '9498167b9']
INNER = ['92ce415e9', '83671b995', '50147192e', 'a68f07f74', '3a3c58c1f', 'e2e5196f0']
RUNS = ['base'] + [r for r in dict.fromkeys(PROJECT + MAIN + INNER) if r != 'base']
meta = {}
for label in RUNS:
    m = json.load(open(f'{R}/full-{label}/meta.json'))
    assert m.get('environment') == 'p0.2' and m.get('screenshots') == 252 and m.get('exit') == 0, (label, m.get('environment'), m.get('screenshots'), m.get('exit'))
    meta[label] = {'commit': m['commit'], 'stats': m['stats'], 'unhandled': m['evidence']['unhandled'], 'pageErrors': m['evidence']['withPageErrors'],
                   'dist': dist(label)}
# Documented below-threshold differences of the current expectation (p3.2-accepted, webkit-scroll-lock-accepted, p0-drift-7).
P32 = {'chromium-dark-phone/task-action-menu.png', 'webkit-dark-phone/task-action-menu.png', 'webkit-dark-phone/task-detail.png',
       'webkit-dark-phone/task-action-hover.png', 'webkit-dark-phone/task-action-focus.png', 'webkit-dark-desktop/breakpoint-599-dialog.png',
       'webkit-dark-desktop/breakpoint-601-dialog.png', 'webkit-light-desktop/breakpoint-599-dialog.png', 'webkit-light-desktop/breakpoint-601-dialog.png'}
SCROLL_LOCK = {'webkit-light-phone/settings-saved.png', 'webkit-light-phone/profile-validation.png'}
A14_ON_ACCEPTED = {f'{p}/notification-error.png' for p in ('webkit-light-desktop', 'webkit-dark-desktop', 'webkit-light-phone', 'webkit-dark-phone')}
P43B = {'webkit-dark-desktop/project-graph-fullscreen.png', 'webkit-light-desktop/project-graph-fullscreen.png'}
BELOW = {**{f: 'P3.2' for f in P32}, **{f: 'WebKit scroll lock' for f in SCROLL_LOCK}, **{f: 'A14 on the accepted entry' for f in A14_ON_ACCEPTED},
         **{f: 'P4.3b' for f in P43B}}
def unchanged(a, b, f):
    r = compare(a, b).get(f) or {}
    if r.get('class') in ('same', 'noise'): return True
    return a == 'expected' and f in BELOW and r.get('p0Comparator') == 'match'
changed = lambda a, b, f: (compare(a, b).get(f) or {}).get('class') == 'changed'
fails = lambda a, b, f: (compare(a, b).get(f) or {}).get('p0Comparator', 'match') != 'match'

base_vs_exp = compare('expected', 'base')
targets = sorted(f for f, r in base_vs_exp.items() if not r.get('missing') and r['class'] == 'changed')
failing = sorted(f for f in targets if base_vs_exp[f]['p0Comparator'] != 'match')
below = sorted(f for f in targets if base_vs_exp[f]['p0Comparator'] == 'match')

def commit_facts(c, line):
    x = full(c)
    return {'commit': x, 'subject': git('log', '-1', '--format=%s', x), 'parents': git('log', '-1', '--format=%P', x).split(),
            'onOriginMain': subprocess.run(['git', '-C', W, 'merge-base', '--is-ancestor', x, 'refs/remotes/origin/main']).returncode == 0,
            'onOriginMainFirstParent': x in git('rev-list', '--first-parent', 'refs/remotes/origin/main').split(),
            'onAbsorbedMainFirstParent': x in git('rev-list', '--first-parent', line).split(),
            'promotionOfThisProject': 'Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7' in git('log', '-1', '--format=%s', x)}
WEB = ['src/web/src', 'src/web/index.html', 'src/web/package.json', 'src/web/vite.config.ts', 'src/web/tsconfig.json', 'src/web/public',
       'src/shared/src', 'src/shared/package.json', 'package-lock.json']
same_inputs = lambda a, b: subprocess.run(['git', '-C', W, 'diff', '--quiet', a, b, '--', *WEB]).returncode == 0
project_line = git('rev-list', '--first-parent', 'bcf00ab95^2').split()
facts = {
    'projectLine': {k: {'commit': full(k), 'subject': git('log', '-1', '--format=%s', k), 'parents': git('log', '-1', '--format=%P', k).split(),
                        'onProjectLineFirstParent': full(k) in project_line}
                    for k in ('7a5a6880a', 'baad1a557', 'cb35d126a', 'd580e572d', '2fcd654d8', 'd354b64c5', '951882866')},
    'newBase': {'commit': full('bcf00ab95'), 'parents': git('log', '-1', '--format=%P', 'bcf00ab95').split(),
                'sameTreeAsProjectTip': full('bcf00ab95^{tree}') == full('951882866^{tree}')},
    'sameWebInputs': {'baad1a557 = ec881f633': same_inputs('baad1a557', 'ec881f633'), 'cb35d126a = 46e28aaa3 (same tree)': full('cb35d126a^{tree}') == full('46e28aaa3^{tree}'),
                      'd580e572d = f0ed9dfc9 (P4.4 code; the rest is tests and docs)': same_inputs('d580e572d', 'f0ed9dfc9'),
                      'e223d8eed = e69765706': same_inputs('e223d8eed', 'e69765706'),
                      '92ce415e9 = f6bf9f496': same_inputs('92ce415e9', 'f6bf9f496'), '43e0eadeb = 83671b995': same_inputs('43e0eadeb', '83671b995'),
                      'c5447f6bf = 56c21bdd2': same_inputs('c5447f6bf', '56c21bdd2'), 'df0bef43d = 50147192e': same_inputs('df0bef43d', '50147192e')},
    'A15': {'X': commit_facts('46e28aaa3', 'cb35d126a^2'), 'productCommit': commit_facts('83671b995', '46e28aaa3^2'),
            'interval': git('log', '--first-parent', '--format=%h %s', 'ec881f633..46e28aaa3').splitlines(),
            'mergeSecondParentLine': git('log', '--first-parent', '--format=%h %s', '46e28aaa3^1..46e28aaa3^2').splitlines(),
            'productWebFiles': git('show', '--format=', '--name-only', '83671b995', '--', 'src/web/src', 'src/shared/src').splitlines()},
    'A16': {'X': commit_facts('e69765706', '2fcd654d8^2'), 'productCommits': [commit_facts('3a3c58c1f', 'df0bef43d'), commit_facts('e2e5196f0', 'df0bef43d')],
            'interval': git('log', '--first-parent', '--format=%h %s', '46e28aaa3..c26b69643').splitlines(),
            'mergeSecondParentLine': git('log', '--first-parent', '--format=%h %s', 'e69765706^1..e69765706^2').splitlines(),
            't7Line': git('log', '--first-parent', '--format=%h %s', '50147192e^1..50147192e^2').splitlines(),
            'productWebFiles': git('show', '--format=', '--name-only', '3a3c58c1f', '--', 'src/web/src', 'src/shared/src').splitlines()
                               + git('show', '--format=', '--name-only', 'e2e5196f0', '--', 'src/web/src', 'src/shared/src').splitlines()},
    'A17': {'X': commit_facts('d2e295917', 'd354b64c5^2'), 'interval': git('log', '--first-parent', '--format=%h %s', 'c26b69643..9498167b9').splitlines(),
            'webFiles': git('show', '--format=', '--name-only', 'd2e295917', '--', 'src/web/src', 'src/shared/src').splitlines()},
    'distEqual': {'92ce415e9 = 56c21bdd2': dist('92ce415e9') == dist('56c21bdd2'), '83671b995 = 46e28aaa3': dist('83671b995') == dist('46e28aaa3')}}
for k in ('A15', 'A16', 'A17'):
    assert facts[k]['X']['onOriginMain'] and facts[k]['X']['onAbsorbedMainFirstParent'] and not facts[k]['X']['promotionOfThisProject'], k
assert all(facts['sameWebInputs'].values()), facts['sameWebInputs']
assert all(facts['distEqual'].values()), facts['distEqual']
assert facts['newBase']['sameTreeAsProjectTip'] and all(v['onProjectLineFirstParent'] for v in facts['projectLine'].values())

rows = {}
CHANGES = {'46e28aaa3': ('A15', ['83671b995', '46e28aaa3']), 'e69765706': ('A16', ['3a3c58c1f', 'e69765706']), 'd2e295917': ('A17', ['d2e295917'])}
for f in targets:
    row = {'baseVsExpectation': px('expected', 'base', f)}
    row['projectLine'] = {'expected vs baad1a557': cls('expected', 'ec881f633', f),
                          **{f'{PROJECT_NAMES[a]} -> {PROJECT_NAMES[b]}': cls(a, b, f) for a, b in zip(PROJECT, PROJECT[1:])}}
    row['mainLine'] = {f'{a} -> {b}': cls(a, b, f) for a, b in zip(MAIN, MAIN[1:])}
    points = [b for a, b in zip(MAIN, MAIN[1:]) if changed(a, b, f)]
    ppoints = [b for a, b in zip(PROJECT, PROJECT[1:]) if changed(a, b, f)]
    row['changePoints'] = {'projectLine': [PROJECT_NAMES[p] for p in ppoints], 'main': points}
    row['crossChecks'] = {'c26b69643 vs 2fcd654d8 (P4.4 on top)': cls('c26b69643', '2fcd654d8', f), '9498167b9 vs d354b64c5 (P4.4 on top)': cls('9498167b9', 'd354b64c5', f)}
    change, mains = [], []
    for p in points:
        if p in CHANGES:
            change.append(CHANGES[p][0]); mains += CHANGES[p][1]
    row['change'], row['mainCommits'] = change, mains
    gen = next((p for p in reversed(points) if p in CHANGES), None)
    row['generatedFrom'] = gen
    # The project line: unchanged up to baad1a557 (the expectation), changes only at the absorbing merge of each X, and
    # nowhere else (P4.4 and the tasks toolbar/Select batches included).
    absorb = {'46e28aaa3': '46e28aaa3', 'e69765706': '2fcd654d8', 'd2e295917': 'd354b64c5'}
    ok = bool(change) and set(points) <= set(CHANGES) and sorted(ppoints) == sorted(absorb[p] for p in points)
    ok = ok and unchanged('expected', 'ec881f633', f)
    # (b): X^1 unchanged against the interval start, X changed and fails the comparator, interval end the same as X.
    if '46e28aaa3' in points:
        ok = ok and unchanged('ec881f633', '56c21bdd2', f) and fails('56c21bdd2', '46e28aaa3', f)
        row['inner'] = {'92ce415e9 -> 83671b995': cls('92ce415e9', '83671b995', f), '56c21bdd2 vs 92ce415e9 (same dist)': cls('56c21bdd2', '92ce415e9', f),
                        '83671b995 vs 46e28aaa3 (same dist)': cls('83671b995', '46e28aaa3', f)}
        ok = ok and fails('92ce415e9', '83671b995', f) and unchanged('56c21bdd2', '92ce415e9', f) and unchanged('83671b995', '46e28aaa3', f)
    else:
        ok = ok and unchanged('ec881f633', '56c21bdd2', f) and unchanged('56c21bdd2', '46e28aaa3', f)
    if 'e69765706' in points:
        ok = ok and fails('46e28aaa3', 'e69765706', f) and unchanged('e69765706', 'c26b69643', f)
        ok = ok and fails('d580e572d', '2fcd654d8', f) and unchanged('c26b69643', '2fcd654d8', f)
        row['inner'] = {'56c21bdd2 (= c5447f6bf) -> 50147192e': cls('56c21bdd2', '50147192e', f), '56c21bdd2 vs a68f07f74': cls('56c21bdd2', 'a68f07f74', f),
                        'a68f07f74 -> 3a3c58c1f': cls('a68f07f74', '3a3c58c1f', f), '3a3c58c1f -> e2e5196f0': cls('3a3c58c1f', 'e2e5196f0', f),
                        'e2e5196f0 vs 50147192e (= df0bef43d)': cls('e2e5196f0', '50147192e', f)}
        ok = ok and fails('56c21bdd2', '50147192e', f) and unchanged('56c21bdd2', 'a68f07f74', f) and fails('a68f07f74', '3a3c58c1f', f)
        ok = ok and unchanged('3a3c58c1f', 'e2e5196f0', f) and unchanged('e2e5196f0', '50147192e', f)
    else:
        ok = ok and unchanged('e69765706', 'c26b69643', f) and unchanged('46e28aaa3', 'e69765706', f)
    if 'd2e295917' in points:
        ok = ok and fails('c26b69643', 'd2e295917', f) and unchanged('d2e295917', '9498167b9', f)
        ok = ok and fails('2fcd654d8', 'd354b64c5', f) and unchanged('9498167b9', 'd354b64c5', f)
    else:
        ok = ok and unchanged('c26b69643', 'd2e295917', f) and unchanged('d2e295917', '9498167b9', f)
    # (d): the migration commits on the project line (P4.4; tasks toolbar and Select/Close) change none of them.
    ok = ok and unchanged('46e28aaa3', 'd580e572d', f) and unchanged('d354b64c5', 'base', f)
    # (e)/(f): the generation run against the new base.
    if gen:
        row['generation'] = {'run': f'full-{gen}', 'vs new base bcf00ab95': cls(gen, 'base', f)}
        ok = ok and unchanged(gen, 'base', f)
    if os.path.isdir(snap('registered')):
        row['registered'] = {'vs new base bcf00ab95': cls('registered', 'base', f)}
        ok = ok and not fails('registered', 'base', f)
    row['attributed'] = ok
    rows[f] = row
documented = sorted(f for f in below if f in BELOW)
# P4.4 (migration, 904a0dcca..d580e572d on the project line): the Wiki new-entry dialog moved to the Orbit Dialog, with
# antialias-level differences below the comparator's threshold that P4.4's own same-commit comparison recorded pixel for
# pixel (p4.4/compare/p0-compare.json). A migration change: never registered as drift, and the accepted-layer tool refuses
# what the comparator cannot see.
p44 = json.load(open(f'{W}/docs/evidence/base-ui-migration/p4.4/compare/p0-compare.json'))['screenshots']
migration_below = {}
for f in below:
    if f in BELOW or not f.endswith('/wiki-new-entry.png'): continue
    r = rows[f]
    only_p44 = r['changePoints'] == {'projectLine': ['d580e572d'], 'main': []} and not fails('46e28aaa3', 'd580e572d', f) and not fails('expected', 'base', f)
    same_px = compare('46e28aaa3', 'd580e572d')[f]['differentPixels'] == p44[f]['pixels'] == compare('expected', 'base')[f]['differentPixels']
    r['migrationBelowThreshold'] = {'change': 'P4.4 (d580e572d): the Wiki new-entry dialog on the Orbit Dialog, antialias-level, under the comparator threshold',
                                    'cb35d126a -> d580e572d': px('46e28aaa3', 'd580e572d', f), 'p4.4 p0-compare.json pixels': p44[f]['pixels'],
                                    'onlyThere': only_p44, 'samePixelCount': same_px}
    if only_p44 and same_px: migration_below[f] = 'P4.4'
unattributed = sorted(f for f, r in rows.items() if not r['attributed'] and f not in documented and f not in migration_below)
summary = {'targets': len(targets), 'failing': len(failing), 'belowThresholdChanged': len(below), 'documentedNotThisBatch': documented,
           'migrationBelowThreshold': migration_below,
           'attributed': sum(1 for r in rows.values() if r['attributed']), 'unattributed': unattributed, 'byChange': {}}
for f, r in rows.items():
    if r['attributed']:
        summary['byChange'].setdefault('+'.join(r['change']), []).append(f)
json.dump({'summary': summary, 'meta': meta, 'facts': facts, 'rows': rows}, open(OUT, 'w'), indent=1, ensure_ascii=False)
open(OUT, 'a').write('\n')
short = lambda v: v.replace(' (fails P0 comparator)', '，比较器失败').replace('same', '相同').replace('noise', '噪声').replace('changed', '变化')
with open(MD, 'w') as md:
    md.write('| 截图 | 新基础对照当前期望 | 归因 | 项目线 baad1a557→cb35d126a→d580e572d→2fcd654d8→d354b64c5→951882866 | main 线的变化点（X^1→X） | 合并内部 | 生成运行对新基础 |\n| --- | --- | --- | --- | --- | --- | --- |\n')
    for f, row in rows.items():
        t = row['baseVsExpectation']
        if f in documented and not row['change']:
            md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，通过 | 不属本批：已记录的低于阈值差异（{BELOW[f]}） | — | — | — | — |\n")
            continue
        if f in migration_below:
            md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，通过 | 不登记：P4.4 的迁移差异，低于阈值（p4.4 同提交对照记录的像素数相同） | 只在 cb35d126a→d580e572d 变化 | — | — | — |\n")
            continue
        pl = ' / '.join(short(v) for k, v in row['projectLine'].items() if k != 'expected vs baad1a557')
        g = row.get('generation', {})
        inner = '; '.join(f'{k}：{short(v)}' for k, v in row.get('inner', {}).items()) or '—'
        md.write(f"| {f} | {t['differentPixels']} px，单通道差 {t['maxChannelDelta']}，{'失败' if t['p0Comparator'] != 'match' else '通过'} | "
                 f"{'+'.join(row['change']) or '—'}{'' if row['attributed'] else '（未归因）'} | {pl} | {', '.join(row['changePoints']['main']) or '—'} | {inner} | "
                 f"{short(g.get('vs new base bcf00ab95', '—'))} |\n")
print(json.dumps(summary, indent=1)[:3000])
