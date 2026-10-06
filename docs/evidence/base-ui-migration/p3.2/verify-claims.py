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

print(f'{sum(results)}/{len(results)} claims hold')
sys.exit(0 if all(results) else 1)
