"""Classify the pilot comparisons of this task's fixes into pilot-summary.json (as ../p2-keyboard-window/summarize-pilot.py).

Each pilot-*.json here is the output of ../p3.2/compare_runs.py (unchanged) for one pair of pilot runs:
`compare` is before-fix vs fixed, `noise-before` and `noise-after` compare each tree with a second run of
itself, and `compare-again` the two second runs. A screenshot is byte-identical, anti-aliasing level (every
differing pixel at most 2 per channel, as P3.1/P3.2 judge) or beyond. A trace step is the same when the
requests it sent are the same; the focus/dialog/list snapshot taken right after an action is listed apart."""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
PAIRS = {
    'compare': 'before-fix run 1 vs fixed run 1',
    'noise-before': 'before-fix run 1 vs before-fix run 2 (same tree)',
    'noise-after': 'fixed run 1 vs fixed run 2 (same tree)',
    'compare-again': 'before-fix run 2 vs fixed run 2',
}


def classify(data):
    shots = {'identical': [], 'antialias': [], 'beyond': {}}
    for name, shot in sorted(data['screenshots'].items()):
        if shot.get('equal'):
            shots['identical'].append(name)
        elif shot.get('maxChannelDiff', 99) <= 2:
            shots['antialias'].append(name)
        else:
            shots['beyond'][name] = {k: shot.get(k) for k in ('pixels', 'pixelsAtMost2', 'maxChannelDiff')}
    steps = {'traces': len(data['traces']), 'identical': 0, 'requestsDiffer': [], 'snapshotOnly': []}
    for name, trace in sorted(data['traces'].items()):
        if trace.get('equal'):
            steps['identical'] += 1
            continue
        for difference in trace['differences']:
            ref, delivered = difference.get('ref') or {}, difference.get('del') or {}
            where = f"{name} :: {difference['step']}"
            if ref.get('requests') != delivered.get('requests'):
                steps['requestsDiffer'].append(where)
            else:
                steps['snapshotOnly'].append({'step': where, 'fields': sorted(k for k in set(ref) | set(delivered)
                                                                               if k not in ('step', 'requests') and ref.get(k) != delivered.get(k))})
    styles = sum(1 for capture in data['styles'].values() if capture) if isinstance(data['styles'], dict) else len(data['styles'])
    return {'screenshots': {'total': len(data['screenshots']), 'identical': len(shots['identical']),
                            'antialias': len(shots['antialias']), 'beyond': shots['beyond']},
            'traces': steps, 'capturesWithStyleDeltas': styles}


summary = {}
for pair, scope in PAIRS.items():
    path = HERE / f'pilot-{pair}.json'
    if path.exists():
        summary[pair] = {'scope': scope, **classify(json.loads(path.read_text()))}
if 'compare' in summary and 'noise-before' in summary and 'noise-after' in summary:
    noisy = set(summary['noise-before']['screenshots']['beyond']) | set(summary['noise-after']['screenshots']['beyond'])
    beyond = summary['compare']['screenshots']['beyond']
    summary['beyondInCompareAlsoNoisyWithinATree'] = sorted(set(beyond) & noisy)
    summary['beyondInCompareOnly'] = sorted(set(beyond) - noisy)
(HERE / 'pilot-summary.json').write_text(json.dumps(summary, indent=1, ensure_ascii=False) + '\n')
for pair, entry in summary.items():
    if isinstance(entry, dict):
        shots, traces = entry['screenshots'], entry['traces']
        print(pair, f"shots {shots['identical']}/{shots['antialias']}/{len(shots['beyond'])} of {shots['total']}",
              f"traces identical {traces['identical']}/{traces['traces']}, requests differ {len(traces['requestsDiffer'])},",
              f"snapshot-only {len(traces['snapshotOnly'])}, style deltas {entry['capturesWithStyleDeltas']}")
    else:
        print(pair, entry)
