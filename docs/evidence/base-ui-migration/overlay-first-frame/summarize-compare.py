"""Classify ../p3.2/compare_runs.py outputs (pilot and P4.1 suites, reference vs fixed, and each tree against a second
run of itself) into compare/summary.json.

usage: summarize-compare.py <name>=<compare_runs output> ... > compare/summary.json

A screenshot is byte-identical, anti-aliasing level (every differing pixel at most 2 per channel, as P3.1/P3.2 judge)
or beyond; for the ones beyond, the differing pixels, the largest channel difference and the clusters' boxes. A trace
step is the same when the requests it sent are the same; steps that differ only in the focus/dialog/list snapshot taken
right after the action are listed apart. Computed-style captures: the number that differ."""
import json
import sys

out = {}
for argument in sys.argv[1:]:
    name, path = argument.split('=', 1)
    data = json.load(open(path))
    shots = {'identical': 0, 'antialias': [], 'beyond': {}}
    for shot, entry in sorted(data['screenshots'].items()):
        if entry.get('equal'):
            shots['identical'] += 1
        elif entry.get('maxChannelDiff', 99) <= 2:
            shots['antialias'].append(shot)
        else:
            shots['beyond'][shot] = {'pixels': entry.get('pixels'), 'maxChannelDiff': entry.get('maxChannelDiff'),
                                     'clusters': [{key: cluster[key] for key in ('x', 'y', 'pixels', 'maxChannelDiff')} for cluster in entry.get('clusters', [])][:6]}
    traces = data.get('traces', {})
    styles = data.get('styles', {})
    out[name] = {
        'screenshots': len(data['screenshots']), 'identical': shots['identical'], 'antialias': len(shots['antialias']),
        'beyond': shots['beyond'], 'antialiasShots': shots['antialias'],
        'traces': len(traces), 'tracesEqual': sum(1 for entry in traces.values() if entry.get('equal')),
        'tracesRequestsDiffer': sorted(trace for trace, entry in traces.items() if not entry.get('equal')
                                       and any(step.get('ref', {}).get('requests') != step.get('del', {}).get('requests') for step in entry.get('differences', []))),
        'tracesSnapshotOnly': {trace: [step['step'] for step in entry.get('differences', [])] for trace, entry in traces.items() if not entry.get('equal')
                               and all(step.get('ref', {}).get('requests') == step.get('del', {}).get('requests') for step in entry.get('differences', []))},
        'styleCaptures': len(styles), 'styleCapturesDiffering': sum(1 for entry in styles.values() if entry),
    }
json.dump(out, sys.stdout, indent=1)
print()
