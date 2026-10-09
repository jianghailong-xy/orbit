#!/usr/bin/env python3
"""The project graph's existing layout defects, measured on both trees beside P0.2's own records.

usage: graph-geometry.py P0.2_BASELINE_RUN_DIR RUNS_DIR > graph-geometry.json

P0.2 recorded (README, baseline-run/*--computed-styles-and-timings.json `graphGeometry`): at 639px the last
mark runs about 31px past the strip's bottom; at 641px the first mark lies under the zoom toolbar; at
1280px the marks end at the strip's bottom edge (about 1px clipped). This reads:
- P0.2's records (breakpoint-639/641-graph, project-graph at 1280) on the four desktop environments;
- the same captures in this batch's P0 matrix runs on the reference and the delivery (f-p0-ref-out,
  f-p0-del-out), which run P0.2's own scenario on today's fixtures;
- the P4.3b geometry case (p43b.browser.mjs, its trace `geometry`: strip, marks, zoom toolbar,
  marks past the strip, marks under the toolbar) on both trees.
For each it gives the strip's box, how far the lowest mark runs past the strip's bottom (`clipped`, px)
and which marks the toolbar covers. Only reads.
"""
import base64, glob, json, os, sys

baseline_dir, runs = sys.argv[1:3]


def from_capture(capture):
    geometry = capture.get('graphGeometry') or []
    strip = next((g for g in geometry if g['label'] == 'graph'), None)
    marks = [g for g in geometry if g['label'] != 'graph']
    if not strip or not marks:
        return None
    return {'strip': {k: round(strip[k], 2) for k in ('top', 'bottom', 'height', 'width')},
            'lowestMarkBottom': round(max(m['bottom'] for m in marks), 2),
            'clipped': round(max(m['bottom'] for m in marks) - strip['bottom'], 2),
            'marks': [{'label': m['label'][:30], 'x': round(m['left'], 2), 'y': round(m['top'], 2), 'bottom': round(m['bottom'], 2)} for m in marks]}


WANT = {'breakpoint-639-graph': 639, 'breakpoint-641-graph': 641, 'project-graph': 1280}
out = {'p0.2': {}, 'p0-matrix': {}, 'p43b-case': {}}
for path in sorted(glob.glob(os.path.join(baseline_dir, '*-desktop--*computed-styles-and-timings.json'))):
    env = os.path.basename(path).split('--')[0]
    for capture in json.load(open(path))['captures']:
        if capture['name'] in WANT:
            out['p0.2'].setdefault(env, {})[WANT[capture['name']]] = from_capture(capture)


def evidence_of(report_path):
    found = {}

    def walk(suite):
        for child in suite.get('suites', []):
            walk(child)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    for attachment in result.get('attachments', []):
                        if attachment['name'] == 'computed-styles-and-timings' and attachment.get('path') and os.path.exists(attachment['path']):
                            found.setdefault(test['projectName'], []).append(json.load(open(attachment['path'])))
                        if attachment['name'] == 'trace' and 'body' in attachment and 'layout defects' in spec['title']:
                            found.setdefault(('trace', test['projectName']), json.loads(base64.b64decode(attachment['body'])))
    for suite in json.load(open(report_path))['suites']:
        walk(suite)
    return found


for tree in ('ref', 'del'):
    report = os.path.join(runs, f'f-p0-{tree}-out', 'report.json')
    if os.path.exists(report):
        for env, evidences in evidence_of(report).items():
            if isinstance(env, tuple) or not env.endswith('desktop'):
                continue
            for evidence in evidences:
                for capture in evidence['captures']:
                    if capture['name'] in WANT:
                        out['p0-matrix'].setdefault(tree, {}).setdefault(env, {})[WANT[capture['name']]] = from_capture(capture)
    report = os.path.join(runs, f'f-p43b-{tree}-out', 'report.json')
    if os.path.exists(report):
        for key, trace in evidence_of(report).items():
            if not isinstance(key, tuple):
                continue
            env = key[1]
            for step in trace:
                g = step.get('geometry')
                if not g:
                    continue
                width = int(step['step'].rstrip('px'))
                out['p43b-case'].setdefault(tree, {}).setdefault(env, {})[width] = {
                    'strip': {k: round(g['strip'][k], 2) for k in ('y', 'bottom', 'height', 'width')},
                    'clippedBelow': round(g['clippedBelow'], 2) if g['clippedBelow'] is not None else None,
                    'overlapsControls': g['overlapsControls'],
                    'controls': {k: round(g['controls'][k], 2) for k in ('x', 'y', 'right', 'bottom')} if g['controls'] else None,
                    'marks': [{'label': m['label'], 'x': round(m['x'], 2), 'y': round(m['y'], 2), 'bottom': round(m['bottom'], 2)} for m in g['marks']],
                }
same = {}
for section in ('p0-matrix', 'p43b-case'):
    ref, dele = out[section].get('ref', {}), out[section].get('del', {})
    same[section] = {env: ref.get(env) == dele.get(env) for env in sorted(set(ref) | set(dele))}
out['referenceEqualsDelivery'] = same
json.dump(out, sys.stdout, indent=1, sort_keys=True)
print()
