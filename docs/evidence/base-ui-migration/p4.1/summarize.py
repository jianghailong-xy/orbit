#!/usr/bin/env python3
"""Summarize a compare_runs.py result (docs/evidence/base-ui-migration/p3.2/compare_runs.py).

usage: summarize.py COMPARE.json > SUMMARY.json

Screenshots fall in three classes, as P3.1/P3.2 judged them: byte-identical, antialias-level (every
differing pixel differs by at most 2 in every channel) and beyond. Every beyond-level screenshot is
listed with its pixel count, largest channel difference and the boxes of its differing clusters; every
trace that differs is listed by its first differing steps. Only reads.
"""
import json
import sys

data = json.load(open(sys.argv[1]))
classes = {'identical': [], 'antialias': [], 'beyond': [], 'missing': []}
for name, shot in sorted(data['screenshots'].items()):
    if 'equal' not in shot:
        classes['missing'].append(name)
    elif shot['equal']:
        classes['identical'].append(name)
    elif shot.get('maxChannelDiff', 999) <= 2:
        classes['antialias'].append(name)
    else:
        classes['beyond'].append({'shot': name, 'pixels': shot.get('pixels'), 'max': shot.get('maxChannelDiff'),
                                  'clusters': [[c['x'], c['y'], c['pixels'], c['maxChannelDiff']] for c in shot.get('clusters', [])[:6]]})
traces = {name: t for name, t in data['traces'].items() if not t['equal']}
summary = {
    'screenshots': {key: len(value) for key, value in classes.items()},
    'beyond': classes['beyond'],
    'missing': classes['missing'],
    'tests': {'total': len(data['tests']), 'notPassedRef': [k for k, v in data['tests'].items() if v['ref'] != 'passed'],
              'notPassedDel': [k for k, v in data['tests'].items() if v['del'] != 'passed']},
    'traces': {'total': len(data['traces']), 'equal': len(data['traces']) - len(traces),
               'differing': {name: t.get('differences', [])[:4] for name, t in traces.items()}},
    'styleDeltas': {name: delta for name, delta in data['styles'].items() if delta},
}
json.dump(summary, sys.stdout, indent=1, ensure_ascii=False, sort_keys=True)
print()
