#!/usr/bin/env python3
"""analyze.py V EVIDENCE: read the final round's runs (V/runs, written by final.sh) and write compare/ under V:

- runs.json: every run's counts (expected, unexpected, flaky, skipped) and its failing tests with their first error line;
- first-option.json: choices-first-option on both trees, per environment, case and opener: the option each system's list
  was on, what Enter left, and whether the test passed;
- close-hover.json: overlays-close-hover on both trees, per environment: each Close at rest and hovered;
- p43a-shots.json: P4.3a's coordinator case, every screenshot of the delivery against the reference: byte-identical,
  anti-aliasing level (every differing pixel at most 2 per channel) or beyond, with the >2-level pixel count and box;
- rebind-vs-antd.json: the delivery's and the reference's p43a-coordinator-rebind against P4.3a's own reference
  (the AntD rebind dialog) and delivery, in the region where those two differ (the list's first option), padded;
- pages.json, icon-hover.json, select-openers.json: what the probes recorded;
- keyboard.json: the P2 keyboard-window suites: per run, target and sequence, the outcomes of the burst and the paced
  samples, and for each sequence whether the delivery's outcomes equal the reference's.
Only reads the runs (and EVIDENCE/../p4.3a/shots)."""
import base64, collections, json, os, sys
import numpy as np
from PIL import Image

V, EVIDENCE = sys.argv[1:3]
R = os.path.join(V, 'runs')
OUT = os.path.join(V, 'compare')
os.makedirs(OUT, exist_ok=True)


def report(name):
    for path in (f'{R}/{name}-out/report.json', f'{R}/{name}-out/.ui-migration-results/report.json'):
        if os.path.exists(path):
            return json.load(open(path))
    return None


def tests(rep):
    """(file, title, project, status, results) for every test in a Playwright JSON report."""
    def walk(suite, file):
        file = suite.get('file', file)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                yield file, spec['title'], test['projectName'], test['status'], test['results']
        for child in suite.get('suites', []):
            yield from walk(child, file)
    for suite in rep['suites']:
        yield from walk(suite, suite.get('file'))


def attached(results, name):
    for result in results[::-1]:
        for item in result.get('attachments', []):
            if item['name'] == name and 'body' in item:
                return json.loads(base64.b64decode(item['body']))
    return None


def first_error(results):
    for result in results:
        for error in result.get('errors', []):
            text = (error.get('message') or '').strip().splitlines()
            if text:
                return text[0][:300]
    return None


runs = {}
for entry in sorted(os.listdir(R)):
    if not entry.endswith('.txt'):
        continue
    name = entry[:-4]
    log = open(f'{R}/{entry}', errors='replace').read()
    code = [line for line in log.splitlines() if line.startswith('exit=')]
    rep = report(name)
    item = {'exit': code[-1] if code else None}
    if rep:
        item['stats'] = {k: rep['stats'].get(k) for k in ('expected', 'unexpected', 'flaky', 'skipped', 'duration')}
        item['failing'] = [{'project': p, 'title': t, 'status': s, 'error': first_error(res)}
                           for _, t, p, s, res in tests(rep) if s in ('unexpected', 'flaky')]
    runs[name] = item
json.dump(runs, open(f'{OUT}/runs.json', 'w'), indent=1)

# The new resident specs on both trees.
first = {}
close = {}
for tree in ('ref', 'del'):
    rep = report(f'f-first-option-{tree}')
    if rep:
        for _, title, project, status, results in tests(rep):
            record = attached(results, 'first-option')
            first.setdefault(tree, []).append({'project': project, 'test': title, 'status': status,
                                               'antd': record and {k: record['antd'][k] for k in ('highlighted', 'afterEnter', 'expanded', 'focused')},
                                               'orbit': record and {k: record['orbit'][k] for k in ('highlighted', 'afterEnter', 'expanded', 'focused')},
                                               'equal': bool(record) and record['antd'] == record['orbit']})
    rep = report(f'f-close-hover-{tree}')
    if rep:
        for _, title, project, status, results in tests(rep):
            close.setdefault(tree, []).append({'project': project, 'status': status, 'close': attached(results, 'close-hover')})
json.dump(first, open(f'{OUT}/first-option.json', 'w'), indent=1)
json.dump(close, open(f'{OUT}/close-hover.json', 'w'), indent=1)


def compare(a_path, b_path, box=None):
    a = np.asarray(Image.open(a_path).convert('RGBA')).astype(int)
    b = np.asarray(Image.open(b_path).convert('RGBA')).astype(int)
    if a.shape != b.shape:
        return {'class': 'size differs', 'sizes': [list(a.shape), list(b.shape)]}
    if box:
        x0, y0, x1, y1 = box
        a, b = a[y0:y1, x0:x1], b[y0:y1, x0:x1]
    d = np.abs(a - b).max(axis=2)
    if not d.any():
        same_bytes = box is None and open(a_path, 'rb').read() == open(b_path, 'rb').read()
        return {'class': 'byte-identical' if same_bytes else 'pixel-identical', 'differing': 0}
    ys, xs = np.nonzero(d > 2)
    item = {'class': 'beyond' if len(xs) else 'anti-aliasing', 'differing': int((d > 0).sum()), 'over2': int(len(xs)), 'max': int(d.max())}
    if len(xs):
        item['box'] = [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1]
    return item


shots = {}
ref_dir, del_dir = f'{R}/f-p43a-coordinator-ref-shots', f'{R}/f-p43a-coordinator-del-shots'
if os.path.isdir(ref_dir) and os.path.isdir(del_dir):
    for project in sorted(os.listdir(ref_dir)):
        for shot in sorted(os.listdir(f'{ref_dir}/{project}')):
            if os.path.exists(f'{del_dir}/{project}/{shot}'):
                shots[f'{project}/{shot}'] = compare(f'{ref_dir}/{project}/{shot}', f'{del_dir}/{project}/{shot}')
    counts = collections.Counter(item['class'] for item in shots.values())
    json.dump({'counts': counts, 'shots': shots}, open(f'{OUT}/p43a-shots.json', 'w'), indent=1)

# The rebind dialog against P4.3a's own pair: its reference is the AntD dialog, its delivery the Orbit one before this
# batch. The region is where those two differ (the list's first option), padded by 8px.
rebind = {}
p43a = os.path.join(EVIDENCE, '..', 'p4.3a', 'shots', 'p43a-beyond')
for project in sorted(os.listdir(p43a)) if os.path.isdir(p43a) else []:
    antd, before = f'{p43a}/{project}/p43a-coordinator-rebind.reference.png', f'{p43a}/{project}/p43a-coordinator-rebind.delivery.png'
    mine = {tree: f'{R}/f-p43a-coordinator-{tree}-shots/{project}/p43a-coordinator-rebind.png' for tree in ('ref', 'del')}
    if not (os.path.exists(antd) and all(os.path.exists(p) for p in mine.values())):
        continue
    found = compare(antd, before)
    if 'box' not in found:
        continue
    x0, y0, x1, y1 = found['box']
    box = [max(x0 - 8, 0), max(y0 - 8, 0), x1 + 8, y1 + 8]
    rebind[project] = {'region': box, 'p43a antd vs p43a orbit': compare(antd, before, box),
                       'delivery vs p43a antd': compare(mine['del'], antd, box), 'reference vs p43a orbit': compare(mine['ref'], before, box),
                       'delivery vs reference': compare(mine['del'], mine['ref'], box)}
json.dump(rebind, open(f'{OUT}/rebind-vs-antd.json', 'w'), indent=1)

# The probes.
pages = {}
for tree in ('ref', 'del'):
    rep = report(f'f-probe-pages-{tree}')
    if rep:
        for _, title, project, status, results in tests(rep):
            for name in ('pages-coordinator', 'pages-pilot'):
                record = attached(results, name)
                if record:
                    pages.setdefault(project, {}).setdefault(tree, {}).update(record)
json.dump(pages, open(f'{OUT}/pages.json', 'w'), indent=1)
for run, name, out in (('f-probe-icon-hover-del', 'icon-hover', 'icon-hover'), ('f-probe-select-openers-del', 'select-openers', 'select-openers')):
    rep = report(run)
    table = {}
    if rep:
        for _, title, project, status, results in tests(rep):
            table.setdefault(title, {})[project] = attached(results, name)
    json.dump(table, open(f'{OUT}/{out}.json', 'w'), indent=1)

# The P2 keyboard-window suites: one outcome string per sample, grouped by target, sequence and mode.
keyboard = {}
for run, name in (('select-keys', 'select-keys'), ('kw1-select', 'keyboard-window'), ('kw2-select', 'keyboard-window-2'),
                  ('kw1-other', 'keyboard-window'), ('kw2-other', 'keyboard-window-2')):
    for tree in ('ref', 'del'):
        rep = report(f'f-{run}-{tree}')
        if not rep:
            continue
        groups = collections.defaultdict(collections.Counter)
        for _, title, project, status, results in tests(rep):
            if status == 'skipped':
                continue
            record = attached(results, name)
            if not record:
                groups[(title.rsplit(' ', 3)[0], 'no record')][status] += 1
                continue
            outcome = record.get('result') or f"{record.get('after')} | list {'open' if record.get('listboxOpen') else 'closed'}"
            groups[(f"{record['target']} {record['sequence']}", record['mode'])][outcome] += 1
        table = collections.defaultdict(dict)
        for (sequence, mode), outcomes in sorted(groups.items()):
            table[sequence][mode] = dict(outcomes)
        keyboard.setdefault(run, {})[tree] = table
for run, trees in keyboard.items():
    if 'ref' in trees and 'del' in trees:
        trees['same outcomes'] = {sequence: trees['ref'].get(sequence) == trees['del'][sequence] for sequence in trees['del']}
    for tree in ('ref', 'del'):
        if tree in trees:
            trees[f'{tree}: burst as paced'] = {sequence: set(modes.get('burst', {})) == set(modes.get('paced', {}))
                                                for sequence, modes in trees[tree].items() if 'burst' in modes}
json.dump(keyboard, open(f'{OUT}/keyboard.json', 'w'), indent=1, default=list)
print(json.dumps({name: {k: v for k, v in item.items() if k != 'failing'} | {'failing': len(item.get('failing', []))} for name, item in runs.items()}, indent=1))
