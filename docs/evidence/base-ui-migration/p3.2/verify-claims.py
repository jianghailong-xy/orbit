#!/usr/bin/env python3
"""Check the README's claims against the recorded runs: usage verify-claims.py (run in this directory).

Reads checks/*.json (each run's commit, uncommitted paths and exit code), the runs' own output and the
comparison files, and asserts what the README states about the final commit: which runs passed on
which commit, that the pilot's requests and computed styles differ only as described, that the strict
P0 failures are the task scenario's alone, that the review dialogs and OrbitKit match the tip, and
that every choices failure is the one Menu keyboard step the tip fails as well. Prints one line per
claim and exits 1 if any does not hold. Reads only."""
import json
import re
import sys
from pathlib import Path

FINAL, PREVIOUS, TIP = 'abb4c29e7', '5311a0cf7', 'da13423d3'
here = Path(__file__).resolve().parent
results = []


def record(name):
    return json.loads((here / 'checks' / f'{name}.json').read_text())


def log(name):
    return (here / 'checks' / f'{name}.txt').read_text(errors='replace')


def claim(text, ok):
    results.append(ok)
    print(('ok    ' if ok else 'FAILS ') + text)


def ran(name, commit, exit_code=0):
    r = record(name)
    return r['commit'].startswith(commit) and r['exitCode'] == exit_code and (commit == TIP or r['dirty'] == [])


for name in ('build-6', 'pilot-6', 'pilot-compare-6', 'pilot-6-vs-5', 'p0-task-shots-6', 'p0-task-compare-7',
             'bundle-size-2', 'bundle-composition-2', 'orbitkit-2', 'orbitkit-compare-2', 'merge-check-2'):
    claim(f'{name} ran clean on {FINAL} and exited 0', ran(name, FINAL))
claim(f'p0-vs-tip-6 ran clean on {FINAL}', ran('p0-vs-tip-6', FINAL, 1))
for name in ('foundation-regression-2', 'controls-regression-2', 'overlays-regression-2', 'composer-regression-2',
             'toasts-regression-2', 'reviews-3', 'reviews-compare-3', 'motion-repeat', 'merge-check', 'performance-2',
             'performance-motion-2', 'choices-regression-3'):
    expected = 1 if name == 'choices-regression-3' else 0
    claim(f'{name} ran clean on {PREVIOUS} and exited {expected}', ran(name, PREVIOUS, expected))
for name in ('ref-pilot-4', 'ref-reviews', 'ref-motion-repeat', 'ref-performance-2', 'ref-performance-motion-2'):
    claim(f'{name} ran on the tip and exited 0', ran(name, TIP))
tip_swift = record('orbitkit-tip')
claim(f'orbitkit-tip tested the tip ({TIP}, from git archive) and exited 0',
      TIP in ' '.join(tip_swift['command']) and tip_swift['exitCode'] == 0)

pilot = json.loads((here / 'pilot-summary-6.json').read_text())
claim('pilot run 6: 64/64 in both trees', pilot['totals']['tests'] == {'passed/passed': 64})
fields = {f for test in pilot['traces'].values() for step in test.get('steps', []) for f in step['fields']}
claim(f'pilot run 6: no trace step differs in its requests (fields that differ: {sorted(fields)})', 'requests' not in fields)
deltas = [(f, a, b) for capture in pilot['styles'].values() for element in capture.values() for f, (a, b) in element.items()]
precision = all(f == 'lineHeight' and abs(float(a[:-2]) - float(b[:-2])) < 0.0001 for f, a, b in deltas)
claim(f'pilot run 6: all {len(deltas)} computed-style differences are line heights within 0.0001px', precision)
noise = json.loads((here / 'reference-noise-summary.json').read_text())
noisy = {(e, s): (v['pixels'] - v['pixelsAtMost2'], v['maxChannelDiff']) for s, x in noise['screenshots'].items() for e, v in x['beyond'].items()}
beyond = {(e, s): (v['pixels'] - v['pixelsAtMost2'], v['maxChannelDiff']) for s, x in pilot['screenshots'].items() for e, v in x['beyond'].items()}
rest = {k for k, v in beyond.items() if noisy.get(k) != v}
known = {'pilot-share-loading', 'pilot-share-expiry-open', 'pilot-share-access-menu', 'pilot-run-hint', 'pilot-delete-confirm'}
claim(f'pilot run 6: {len(beyond)} shots beyond antialiasing, {len(beyond) - len(rest)} equal to the reference noise, '
      f'the rest only {sorted(known)}', {s for _, s in rest} <= known)
pair = json.loads((here / 'pilot-6-vs-5-summary.json').read_text())
pair_fields = {f for test in pair['traces'].values() for step in test.get('steps', []) for f in step['fields']}
claim('runs 5 and 6: no computed-style difference, no request difference',
      pair['totals']['capturesWithStyleDeltas'] == 0 and 'requests' not in pair_fields)

failed = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/(\S+?):\d+:\d+ › (.+?) \(', log('p0-vs-tip-6'))
claim(f'p0-vs-tip-6: the {len(failed)} failures are the task scenario alone, one per environment',
      len(failed) == 8 and {f[2] for f in failed} == {'task'} and len({f[0] for f in failed}) == 8)
claim('p0-vs-tip-6: 93 passed, 11 skipped', re.search(r'\b93 passed\b', log('p0-vs-tip-6')) is not None
      and re.search(r'\b11 skipped\b', log('p0-vs-tip-6')) is not None)

reviews = json.loads((here / 'reviews-compare-3.json').read_text())
attachments = [v for k, v in reviews.items() if k != '_missing']
claim(f'review dialogs: all {len(attachments)} attachments equal to the tip',
      len(attachments) == 12 and all(v['equal'] for v in attachments) and not any(reviews['_missing'].values()))

orbitkit = json.loads((here / 'orbitkit-compare-2.json').read_text())
claim(f"OrbitKit on {FINAL}: {orbitkit['delivery']['summary']}; no case fails",
      orbitkit['delivery']['failed'] == [] and orbitkit['tip']['failed'] == [])

step = 'choices.browser.mjs:624:80'
for name, count in (('choices-regression-2', 1), ('choices-regression-3', 2), ('multi-dialog-repeat', 9), ('ref-multi-dialog-repeat', 6)):
    text = log(name)
    lines = re.findall(r'at \S+choices\.browser\.mjs:\d+:\d+', text)
    claim(f'{name}: {count} failures, all at the Row actions keyboard step ({step})',
          len(lines) == count and all(l.endswith(step) for l in lines))

# Round 2 (README "第 2 轮：合入 main"): main merged in, the pilot compared again on main as merged.
MAIN, MAIN_NOW = 'f33589b4c', '71e644742'
LINKED, R2, MERGED_AGAIN = '7145f084f', '5ce67d6dd', '3c1b24f02'
claim(f'r2-merge-check ran clean on {LINKED} and exited 0', ran('r2-merge-check', LINKED))
plain = lambda name: re.sub(r'\x1b\[[0-9;]*m', '', log(name))
for name in ('r2-merge-check', 'r2b-merge-check'):
    claim(f'{name}: 338 test files and 4295 tests passed', re.search(r'Test Files\s+338 passed \(338\)', plain(name)) is not None
          and re.search(r'Tests\s+4295 passed \(4295\)', plain(name)) is not None)
for name in ('r2-build', 'r2-pilot', 'r2-pilot-compare', 'r2-pilot-summary', 'r2-merge-scope'):
    claim(f'{name} ran clean on {R2} and exited 0', ran(name, R2))
for name in ('r2-ref-build', 'r2-ref-pilot', 'r2-ref-pilot-again'):
    r = record(name)
    claim(f'{name} ran on main {MAIN} with only the pilot specs copied in, and exited 0',
          r['commit'].startswith(MAIN) and r['exitCode'] == 0 and all(p.startswith('?? src/web/ui-migration/pilot') for p in r['dirty']))

r2 = json.loads((here / 'r2-pilot-summary.json').read_text())
claim('r2 pilot: 72/72 in both trees', r2['totals']['tests'] == {'passed/passed': 72})
claim('r2 pilot: 256 shots, 90 identical, 156 within antialiasing, 10 beyond',
      (r2['totals']['screenshots'], r2['totals']['identical'], r2['totals']['antialias'], r2['totals']['beyondAntialias']) == (256, 90, 156, 10))
r2_fields = {f for test in r2['traces'].values() for step in test.get('steps', []) for f in step['fields']}
claim(f'r2 pilot: no trace step of the 64 differs in its requests (fields that differ: {sorted(r2_fields)})',
      r2['totals']['traces'] == 64 and 'requests' not in r2_fields)
r2_deltas = [(f, a, b) for capture in r2['styles'].values() for element in capture.values() for f, (a, b) in element.items()]
claim(f'r2 pilot: all {len(r2_deltas)} computed-style differences are line heights within 0.0001px',
      all(f == 'lineHeight' and abs(float(a[:-2]) - float(b[:-2])) < 0.0001 for f, a, b in r2_deltas))
choosing = ['pilot-detail', 'pilot-field-hover', 'pilot-assignee-open', 'pilot-suggested-open', 'pilot-provider-open', 'pilot-model-open',
            'pilot-list-open', 'pilot-list-search', 'pilot-account', 'pilot-account-open', 'pilot-antigravity-account', 'pilot-antigravity-account-open']
claim(f'r2 pilot: the {len(choosing)} field, model and account picker shots are identical or within antialiasing in all 8 environments',
      all(r2['screenshots'][s]['environments'] == 8 and not r2['screenshots'][s]['beyond'] for s in choosing))
r2_compare = json.loads((here / 'r2-pilot-compare.json').read_text())
antigravity = {k: v for k, v in r2_compare['traces'].items() if 'Antigravity account picker' in k}
claim('r2 pilot: the Antigravity case differs only at its open and pick steps, never in requests; its Create step is equal in all 8',
      len(antigravity) == 8 and all({d['step'] for d in v.get('differences', [])} <= {'antigravity account open', 'antigravity account Work'}
                                    for v in antigravity.values()))
# The shots beyond antialiasing: the first round's known ones (same environment, same pixel count beyond 2,
# same level as in run 6), and one the reference shows against itself.
v1 = json.loads((here / 'pilot-compare-6.json').read_text())['screenshots']
noise2 = json.loads((here / 'r2-reference-noise-compare.json').read_text())['screenshots']
over = lambda v: (v.get('pixels', 0) - v.get('pixelsAtMost2', 0), v.get('maxChannelDiff'))
r2_beyond = {k: over(v) for k, v in r2_compare['screenshots'].items() if not v.get('equal') and v.get('pixels') != v.get('pixelsAtMost2')}
as_v1 = {k for k, v in r2_beyond.items() if k in v1 and over(v1[k]) == v}
as_noise = {k for k, v in r2_beyond.items() if k in noise2 and over(noise2[k]) == v}
claim(f'r2 pilot: of the {len(r2_beyond)} shots beyond antialiasing, {len(as_v1)} are run 6\'s own, the rest '
      f'({sorted(set(r2_beyond) - as_v1)}) the reference\'s own noise', len(as_v1) == 9 and set(r2_beyond) - as_v1 <= as_noise)
n2 = json.loads((here / 'r2-reference-noise-summary.json').read_text())['totals']
claim('r2 reference noise: 217 identical, 37 within antialiasing, 2 beyond, no computed-style difference',
      (n2['identical'], n2['antialias'], n2['beyondAntialias'], n2['capturesWithStyleDeltas']) == (217, 37, 2, 0))
scope = json.loads((here / 'r2-merge-scope.json').read_text())
claim(f"r2 merge scope: all {len(scope['checks'])} checks hold", all(c['holds'] for c in scope['checks']))
for name in ('r2b-merge-check', 'r2b-merge-scope', 'r2b-dist-compare', 'r2-orbitkit-compare'):
    claim(f'{name} ran clean on {MERGED_AGAIN} and exited 0', ran(name, MERGED_AGAIN))
claim(f'r2-orbitkit (git archive of {MERGED_AGAIN}) and r2-orbitkit-main (of main {MAIN_NOW}) both exited 1, on main\'s own failures (below)',
      ran('r2-orbitkit', MERGED_AGAIN, 1) and record('r2-orbitkit-main')['exitCode'] == 1
      and log('r2-orbitkit').startswith('commit ' + record('r2-orbitkit')['commit']) and log('r2-orbitkit-main').startswith('commit ' + MAIN_NOW))
claim('r2b-dist-compare and r2b-ref-dist-compare: both trees build byte for byte what the pilot comparison served',
      log('r2b-dist-compare').strip() == '' and log('r2b-ref-dist-compare').strip() == '')
for name in ('r2b-ref-build', 'r2b-ref-dist-compare'):
    r = record(name)
    claim(f'{name} ran on main {MAIN_NOW} and exited 0', r['commit'].startswith(MAIN_NOW) and r['exitCode'] == 0)
scope_again = json.loads((here / 'r2b-merge-scope.json').read_text())
claim(f"r2b merge scope (main {MAIN_NOW}): all {len(scope_again['checks'])} checks hold", all(c['holds'] for c in scope_again['checks']))
swift = json.loads((here / 'r2-orbitkit-compare.json').read_text())
claim(f"r2 OrbitKit: no case fails on {MERGED_AGAIN} that passes on main {MAIN_NOW} ({swift['delivery']['summary']})",
      swift['onlyDelivery'] == [] and record('r2-orbitkit-main')['command'][-2] == MAIN_NOW)
claim(f"r2 OrbitKit: main and the delivery fail the same {len(swift['tip']['failed'])} cases",
      swift['tip']['failed'] == swift['delivery']['failed'] and swift['onlyTip'] == [])
claim('r2 OrbitKit: SharePanelCopyParityTests, TaskDetailCopyParityTests and TaskDetailWiringTests pass on both trees',
      all(re.search(rf"Test Suite '{suite}' passed", log(name)) for suite in ('SharePanelCopyParityTests', 'TaskDetailCopyParityTests', 'TaskDetailWiringTests')
          for name in ('r2-orbitkit-main', 'r2-orbitkit')))

# Round 2, the component matrices and the review dialogs on the merged tree.
summary_line = lambda name: ' '.join(re.findall(r'^\s+(\d+ (?:passed|failed|skipped|flaky))', plain(name), re.M))
for name, expected in (('r2b-foundation-regression', '48 passed'), ('r2b-controls-regression', '32 passed'),
                       ('r2b-overlays-regression', '96 passed'), ('r2b-choices-regression', '520 passed'),
                       ('r2b-ref-reviews', '6 skipped 6 passed'), ('r2b-reviews', '6 skipped 6 passed')):
    r = record(name)
    on = MAIN_NOW if name.startswith('r2b-ref-') else MERGED_AGAIN
    claim(f'{name}: {expected} on {on}, exit 0', r['commit'].startswith(on) and r['exitCode'] == 0 and summary_line(name) == expected)
for name, expected in (('r2b-composer-regression', '1 failed 23 skipped 120 passed'), ('r2b-toasts-regression', '4 failed 268 passed')):
    claim(f'{name}: {expected} on {MERGED_AGAIN}', ran(name, MERGED_AGAIN, 1) and summary_line(name) == expected)
motion = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/(\S+?):\d+:\d+ › (.+?) \(', plain('r2b-composer-regression') + plain('r2b-toasts-regression'))
claim(f'r2b composer and toasts: the {len(motion)} failures are all motion or animation-progress samples',
      len(motion) == 5 and all(re.search(r'motion|progress|Drawer', t) for _, _, t in motion))
count = lambda name, word: sum(int(n) for n in re.findall(rf'^\s+(\d+) {word}\b', plain(name), re.M))
repeats = ('composer-motion', 'toasts-drawer-entry', 'toasts-exit-progress', 'toasts-entrance-progress', 'toasts-drawer-pixels')
main_runs = [(count(f'ref-r2b-{r}-repeat', 'passed'), count(f'ref-r2b-{r}-repeat', 'failed')) for r in repeats]
del_runs = [(count(f'r2b-{r}-repeat', 'passed'), count(f'r2b-{r}-repeat', 'failed')) for r in repeats]
claim(f'r2b repeats of the 5 motion failures: main {sum(p for p, _ in main_runs)}/30, the delivery {sum(p for p, _ in del_runs)}/30',
      (sum(p for p, _ in main_runs), sum(p + f for p, f in main_runs), sum(p for p, _ in del_runs), sum(p + f for p, f in del_runs)) == (26, 30, 29, 30)
      and all(record(f'ref-r2b-{r}-repeat')['commit'].startswith(MAIN_NOW) and record(f'r2b-{r}-repeat')['commit'].startswith(MERGED_AGAIN) for r in repeats))
first_reruns = [f'{side}p0-{s}-{e}' for s, e in (('settings', 'webkit-light-desktop'), ('settings', 'webkit-dark-desktop'), ('settings', 'webkit-dark-phone'),
                                                  ('profile', 'chromium-light-desktop'), ('profile', 'webkit-dark-desktop')) for side in ('r2b-ref-', 'r2b-')]
claim('r2b P0 first reruns: all 10 met the saved-toast intermittent (strict mode on the toast and its live region) or the screenshot it left unwritten',
      all(record(n)['exitCode'] == 1 and re.search(r"strict mode violation: getByText\('(Setting|Name) saved'|A snapshot doesn't exist", plain(n)) for n in first_reruns))
reviews2 = json.loads((here / 'r2b-reviews-compare.json').read_text())
attachments2 = [v for k, v in reviews2.items() if k != '_missing']
claim(f'r2b review dialogs: all {len(attachments2)} attachments equal to main\'s',
      len(attachments2) == 12 and all(v['equal'] for v in attachments2) and not any(reviews2['_missing'].values()))

# Round 2, the P0 page matrix: main writes the screenshots, the delivery is compared at 0 pixels.
p0_log = plain('r2b-p0-vs-main')
p0_failed = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/pages\.browser\.mjs:\d+:\d+ › (\w+) \(', p0_log)
ref_failed = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/pages\.browser\.mjs:\d+:\d+ › (\w+) \(', plain('r2b-ref-p0'))
claim('r2b P0: 21 failed, 11 skipped, 80 passed on the delivery; 13 failed, 11 skipped, 88 passed on main',
      summary_line('r2b-p0-vs-main') == '21 failed 11 skipped 80 passed' and summary_line('r2b-ref-p0') == '13 failed 11 skipped 88 passed')
envs = lambda failed, scenario: {e for e, x in failed if x == scenario}
flaky = lambda failed: {(e, x) for e, x in failed if x in ('settings', 'profile')}
claim('r2b P0: the delivery fails task and wiki in all 8 environments and settings/profile exactly where main failed them; '
      'main fails wiki in all 8 and nothing else but settings/profile',
      len(envs(p0_failed, 'task')) == 8 and len(envs(p0_failed, 'wiki')) == 8 and len(envs(ref_failed, 'wiki')) == 8
      and {x for _, x in p0_failed} <= {'task', 'wiki', 'settings', 'profile'} and {x for _, x in ref_failed} <= {'wiki', 'settings', 'profile'}
      and flaky(p0_failed) == flaky(ref_failed))
claim('r2b P0: every wiki failure on either tree is the wait for .wk-card, which main\'s Wiki home no longer draws',
      p0_log.count("Locator: locator('.wk-card').first()") >= 8 and plain('r2b-ref-p0').count("Locator: locator('.wk-card').first()") >= 8)
task2 = json.loads((here / 'r2b-p0-task-summary.json').read_text())['screenshots']
task6 = json.loads((here / 'p0-task-summary-6.json').read_text())['screenshots']
claim('r2b P0 task scenario: task-action-menu and task-share-dialog differ in each environment exactly as in run 6; the other task shots are identical or within antialiasing',
      all({e: over(v) for e, v in task2[s]['beyond'].items()} == {e: over(v) for e, v in task6[s]['beyond'].items()}
          for s in ('task-action-menu', 'task-share-dialog', 'task-public-share'))
      and all(not task2[s]['beyond'] for s in ('task-detail', 'task-action-hover', 'task-action-focus')))

# Round 2c: the project line (77233e226) and main (86203ffb0) moved again; both merged (9fa5fc412) and checked
# against their merge without this batch, 760287474, as the base.
import subprocess
BASE_NOW, FINAL_SRC, CHECKED = '760287474', '9fa5fc412', 'e3ba1c923'
git = lambda *args: subprocess.run(['git', '-C', str(here.parents[3]), *args], capture_output=True, text=True)
claim(f'{CHECKED} carries the source of {FINAL_SRC} (only this directory changed after it)',
      git('diff', '--quiet', FINAL_SRC, CHECKED, '--', '.', ':(exclude)docs/evidence/base-ui-migration/p3.2').returncode == 0)
claim(f'{BASE_NOW} is the merge of the project tip 77233e226 and main 86203ffb0',
      git('rev-list', '--parents', '-n', '1', BASE_NOW).stdout.split()[1:] == [git('rev-parse', '77233e226').stdout.strip(), git('rev-parse', '86203ffb0').stdout.strip()])
claim(f'r2c-merge-check ran clean on {CHECKED} and exited 0: 340 test files and 4327 tests passed',
      ran('r2c-merge-check', CHECKED) and re.search(r'Test Files\s+340 passed \(340\)', plain('r2c-merge-check')) is not None
      and re.search(r'Tests\s+4327 passed \(4327\)', plain('r2c-merge-check')) is not None)
for name in ('r2c-merge-scope', 'r2c-build', 'r2c-pilot', 'r2c-pilot-compare', 'r2c-pilot-summary', 'r2c-orbitkit', 'r2c-orbitkit-main', 'r2c-orbitkit-compare'):
    claim(f'{name} ran clean on {CHECKED} and exited 0', ran(name, CHECKED))
copied = re.compile(r'^\?\? src/web/ui-migration/(pilot[\w.-]*|p32-reference\.config\.mjs|port\.config\.mjs)$')
for name in ('r2c-ref-build', 'r2c-ref-pilot'):
    r = record(name)
    claim(f'{name} ran on {BASE_NOW} with only the pilot specs and configs copied in, and exited 0',
          r['commit'].startswith(BASE_NOW) and r['exitCode'] == 0 and all(copied.match(p) for p in r['dirty']))
scope_c = json.loads((here / 'r2c-merge-scope.json').read_text())
claim(f"r2c merge scope: all {len(scope_c['checks'])} checks hold; {len(scope_c['changedByBoth'])} files changed by both sides",
      all(c['holds'] for c in scope_c['checks']) and len(scope_c['checks']) == 16 and len(scope_c['changedByBoth']) == 5)
r2c = json.loads((here / 'r2c-pilot-summary.json').read_text())
claim('r2c pilot: 72/72 in both trees; 256 shots, 95 identical, 153 within antialiasing, 8 beyond',
      r2c['totals']['tests'] == {'passed/passed': 72}
      and (r2c['totals']['screenshots'], r2c['totals']['identical'], r2c['totals']['antialias'], r2c['totals']['beyondAntialias']) == (256, 95, 153, 8))
r2c_fields = {f for test in r2c['traces'].values() for step in test.get('steps', []) for f in step['fields']}
claim(f'r2c pilot: no trace step of the 64 differs in its requests (fields that differ: {sorted(r2c_fields)})',
      r2c['totals']['traces'] == 64 and 'requests' not in r2c_fields)
r2c_deltas = [(f, a, b) for capture in r2c['styles'].values() for element in capture.values() for f, (a, b) in element.items()]
claim(f'r2c pilot: all {len(r2c_deltas)} computed-style differences are line heights within 0.0001px',
      all(f == 'lineHeight' and abs(float(a[:-2]) - float(b[:-2])) < 0.0001 for f, a, b in r2c_deltas))
claim(f'r2c pilot: the {len(choosing)} field, model and account picker shots are identical or within antialiasing in all 8 environments',
      all(r2c['screenshots'][s]['environments'] == 8 and not r2c['screenshots'][s]['beyond'] for s in choosing))
r2c_compare = json.loads((here / 'r2c-pilot-compare.json').read_text())
r2c_beyond = {k: over(v) for k, v in r2c_compare['screenshots'].items() if not v.get('equal') and v.get('pixels') != v.get('pixelsAtMost2')}
claim(f'r2c pilot: all {len(r2c_beyond)} shots beyond antialiasing are run 6\'s own (same environment, pixels beyond 2 and level)',
      len(r2c_beyond) == 8 and all(k in v1 and over(v1[k]) == v for k, v in r2c_beyond.items()))
antigravity_c = {k: v for k, v in r2c_compare['traces'].items() if 'Antigravity account picker' in k}
claim('r2c pilot: the Antigravity case differs only at its open and pick steps; its Create step is equal in all 8',
      len(antigravity_c) == 8 and all({d['step'] for d in v.get('differences', [])} <= {'antigravity account open', 'antigravity account Work'}
                                      for v in antigravity_c.values()))
ref_p0_c = record('r2c-ref-p0')
claim(f'r2c-ref-p0 ran on {BASE_NOW} with only the pilot specs and configs copied in: 8 failed, 11 skipped, 93 passed',
      ref_p0_c['commit'].startswith(BASE_NOW) and ref_p0_c['exitCode'] == 1 and all(copied.match(p) for p in ref_p0_c['dirty'])
      and summary_line('r2c-ref-p0') == '8 failed 11 skipped 93 passed')
claim(f'r2c-p0-vs-main ran clean on {CHECKED}: 16 failed, 11 skipped, 85 passed',
      ran('r2c-p0-vs-main', CHECKED, 1) and summary_line('r2c-p0-vs-main') == '16 failed 11 skipped 85 passed')
ref_failed_c = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/(\S+?):\d+:\d+ › (.+?) \(', plain('r2c-ref-p0'))
del_failed_c = re.findall(r'✘\s+\d+ \[([\w-]+)\] › ui-migration/(\S+?):\d+:\d+ › (.+?) \(', plain('r2c-p0-vs-main'))
unexpected = lambda failed: {(e, t) for e, f, t in failed if not t.startswith('P0.2-FOCUS')}
claim('r2c P0: main fails only wiki (all 8 environments); the delivery fails only task and wiki (all 8 each); both wait in vain for .wk-card',
      {t for _, t in unexpected(ref_failed_c)} == {'wiki'} and len(unexpected(ref_failed_c)) == 8
      and {t for _, t in unexpected(del_failed_c)} == {'task', 'wiki'} and len(unexpected(del_failed_c)) == 16
      and plain('r2c-ref-p0').count("Locator: locator('.wk-card').first()") == 8 and plain('r2c-p0-vs-main').count("Locator: locator('.wk-card').first()") == 8)
for name in ('r2c-p0-task-shots', 'r2c-p0-task-compare', 'r2c-p0-task-summary'):
    claim(f'{name} ran clean on {CHECKED} and exited 0', ran(name, CHECKED))
task_c = json.loads((here / 'r2c-p0-task-summary.json').read_text())
claim('r2c P0 task scenario: 18 identical, 6 within antialiasing, 24 beyond, each shot per environment as in run 6',
      (task_c['totals']['identical'], task_c['totals']['antialias'], task_c['totals']['beyondAntialias']) == (18, 6, 24)
      and all({e: over(v) for e, v in task_c['screenshots'][s]['beyond'].items()} == {e: over(v) for e, v in task6[s]['beyond'].items()}
              and (task_c['screenshots'][s]['identical'], task_c['screenshots'][s]['antialias']) == (task6[s]['identical'], task6[s]['antialias'])
              for s in task6))
swift_c = json.loads((here / 'r2c-orbitkit-compare.json').read_text())
claim(f"r2c OrbitKit: {BASE_NOW} and {CHECKED} both run clean ({swift_c['delivery']['summary']})",
      swift_c['tip']['failed'] == [] and swift_c['delivery']['failed'] == [] and log('r2c-orbitkit-main').startswith('commit ' + git('rev-parse', BASE_NOW).stdout.strip())
      and log('r2c-orbitkit').startswith('commit ' + record('r2c-orbitkit')['commit']))

# Round 2d: main moved by one runner test commit (db69d833b) before the evidence; merged as 6bd41335a.
FINAL = '6bd41335a'
moved = git('diff', '--name-only', FINAL_SRC, FINAL, '--', '.', ':(exclude)docs/evidence/base-ui-migration/p3.2').stdout.split()
claim(f'{FINAL} differs from {FINAL_SRC} only in {len(moved)} Go runner test files', moved and all(p.startswith('src/runner-go/') and p.endswith('_test.go') for p in moved))
claim(f'r2d-merge-check ran clean on {FINAL} and exited 0: 340 test files and 4327 tests passed',
      ran('r2d-merge-check', FINAL) and re.search(r'Test Files\s+340 passed \(340\)', plain('r2d-merge-check')) is not None
      and re.search(r'Tests\s+4327 passed \(4327\)', plain('r2d-merge-check')) is not None)

print(f'{sum(results)}/{len(results)} claims hold')
sys.exit(0 if all(results) else 1)
