#!/usr/bin/env python3
"""Summarise compare_runs.py output: usage summarize-compare.py pilot-compare.json > pilot-summary.json

Per screenshot: in how many environments it is byte-identical, differs only at antialiasing level
(every differing pixel within 2 per channel) or differs more, with the largest channel difference and
the count of pixels beyond 2. Per test: whether the per-step traces are equal, and for unequal ones the
fields that differ at each step. Per capture: the computed-style fields that differ. Reads only."""
import json
import sys
from collections import defaultdict

data = json.load(open(sys.argv[1]))
shots = defaultdict(lambda: {'environments': 0, 'identical': 0, 'antialias': 0, 'beyond': {}})
for key, value in sorted(data['screenshots'].items()):
    environment, name = key.split('/', 1)
    entry = shots[name.removesuffix('.png')]
    entry['environments'] += 1
    if value.get('equal'):
        entry['identical'] += 1
    elif 'pixels' in value and value['pixels'] == value['pixelsAtMost2']:
        entry['antialias'] += 1
    else:
        entry['beyond'][environment] = {k: value.get(k) for k in ('pixels', 'pixelsAtMost2', 'maxChannelDiff', 'sizeRef', 'sizeDel', 'missingInDelivery', 'missingInReference') if value.get(k) is not None}

traces = {}
for label, value in sorted(data['traces'].items()):
    steps = []
    for difference in value.get('differences', []):
        ref, delivered = difference['ref'], difference['del']
        fields = sorted(k for k in set(ref) | set(delivered) if ref.get(k) != delivered.get(k))
        steps.append({'step': difference['step'], 'fields': fields})
    traces[label] = {'equal': value['equal'], 'steps': steps, **({'lengths': value['lengths']} if 'lengths' in value else {})}

styles = {key: value for key, value in sorted(data['styles'].items()) if value}
totals = {
    'screenshots': len(data['screenshots']),
    'identical': sum(1 for v in data['screenshots'].values() if v.get('equal')),
    'antialias': sum(1 for v in data['screenshots'].values() if 'pixels' in v and v['pixels'] == v['pixelsAtMost2']),
    'tests': {status: sum(1 for t in data['tests'].values() if (t['ref'], t['del']) == status) for status in {(t['ref'], t['del']) for t in data['tests'].values()}},
    'traces': len(traces), 'tracesEqual': sum(1 for t in traces.values() if t['equal']),
    'capturesWithStyleDeltas': len(styles), 'captures': len(data['styles']),
}
totals['tests'] = {f'{a}/{b}': n for (a, b), n in totals['tests'].items()}
totals['beyondAntialias'] = totals['screenshots'] - totals['identical'] - totals['antialias']
json.dump({'totals': totals, 'screenshots': shots, 'traces': traces, 'styles': styles}, sys.stdout, indent=1, ensure_ascii=False)
print()
