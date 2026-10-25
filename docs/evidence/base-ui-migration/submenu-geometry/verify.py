"""verify.py: the README's numbers, recomputed from the committed files in this directory alone.

For each run copy: the tree and commit it ran on, its exit line and its results by status. Then the comparisons the
README draws from them: the resident check's boxes before and after the fix, the P0 same-commit pair, the threshold
probe and the merge check's totals. Run it from this directory: python3 verify.py
"""
import collections
import json
import os


def walk(suites):
    for suite in suites:
        yield from walk(suite.get('suites', []))
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                yield spec, test


def statuses(path):
    report = json.load(open(path))
    return {(test['projectName'], spec['file'], spec['title']): (test['results'][-1]['status'] if test['results'] else 'skipped')
            for spec, test in walk(report['suites'])}


def shape(record):
    item, sub = record['item'], record['submenu']
    return (sub['x'] + sub['width'] / 2 > item['x'] + item['width'] / 2, round(sub['x'] - item['x'], 3),
            round(sub['y'] - item['y'], 3), sub['width'], sub['height'])


print('== runs')
for name in sorted(os.listdir('runs')):
    run = os.path.join('runs', name)
    lines = open(os.path.join(run, 'run.txt')).read().split('\n') if os.path.exists(os.path.join(run, 'run.txt')) else []
    head = next((part[5:14] for line in lines for part in line.split() if part.startswith('head=')), '-')
    end = next((line.split()[0] for line in lines if line.startswith('exit=')), '-')
    counts = ''
    if os.path.exists(os.path.join(run, 'report.summary.json')):
        counts = dict(collections.Counter(statuses(os.path.join(run, 'report.summary.json')).values()))
    print(f'{name:18s} {head:10s} {end:7s} {counts}')

print('\n== resident check (choices-submenu-geometry): boxes from the item, AntD against Orbit')
for name in ('geometry-before', 'choices'):
    geometry = json.load(open(f'runs/{name}/geometry.json'))
    cases = [record for tests in geometry.values() for places in tests.values() for record in places.values()]
    same_box = sum(shape(r['antd']) == shape(r['orbit']) for r in cases)
    same_place = sum(r['antd']['item'] == r['orbit']['item'] for r in cases)
    print(f'{name:16s} {len(cases)} cases, same box {same_box}, item at the same place {same_place}')

print('\n== P0 same-commit pair (vite build bundle, 5e17800a0)')
before, after = statuses('runs/p0-before/report.summary.json'), statuses('runs/p0-after/report.summary.json')
print(f'{len(before)} / {len(after)} tests, identical results: {before == after}, {dict(collections.Counter(after.values()))}')

print('\n== threshold probe: positions where both systems have the same box, and where each first flips')
for name in ('threshold-before', 'threshold-after'):
    for project, tests in json.load(open(f'runs/{name}/threshold.json')).items():
        rows = next(iter(tests.values()))
        flips = {system: next((row['left'] for row in rows if row[system]['sub'][0] < row[system]['item'][0]), None) for system in ('antd', 'orbit')}
        same = sum(row['antd']['sub'] == row['orbit']['sub'] for row in rows)
        print(f'{name:17s} {project:22s} {len(rows)} positions, same box {same}, first flip at left={flips}')

print('\n== merge check')
for line in open('runs/merge-check/output-summary.txt'):
    if line.strip().startswith(('Test Files', 'Tests ')):
        print(line.rstrip())
print('test files shown passed:', sum(1 for line in open('runs/merge-check/output-summary.txt') if line.startswith(' ✓ src/')))
