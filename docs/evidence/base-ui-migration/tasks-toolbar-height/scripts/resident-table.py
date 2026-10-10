#!/usr/bin/env python3
"""resident-table.py [--json OUT] REPORT.json...: the resident spec's Playwright reports (attachment bodies kept) read
step by step. Every check attached its geometry ("geometry: <step>"); a step is off when the toolbar is not as tall as
the bulk bar or the list does not start the toolbar's margin below the bar (the spec's two soft checks, 0.5px). Prints
per tree, project and step how many of the runs were off, plus the tests' own outcomes; --json writes the same."""
import base64, collections, json, os, re, sys

args = sys.argv[1:]
out = None
if args and args[0] == '--json':
    out, args = args[1], args[2:]

def tests(suite):
    for spec in suite.get('specs', []):
        for t in spec.get('tests', []):
            yield spec['title'], t
    for child in suite.get('suites', []):
        yield from tests(child)

steps = collections.OrderedDict()
outcomes = collections.Counter()
errors = collections.Counter()
for path in args:
    folder = os.path.dirname(path)
    if os.path.basename(folder) == 'out':  # the exploratory runs (resident.sh): runs/resident-LABEL/out
        folder = os.path.dirname(folder)
    label = re.sub(r'-(r)?\d+(-out)?$', '', os.path.basename(folder)).removeprefix('resident-')
    report = json.load(open(path))
    for suite in report['suites']:
        for title, t in tests(suite):
            project = t['projectName']
            for result in t['results']:
                outcomes[(label, project, result['status'])] += 1
                for e in result.get('errors', []):
                    m = re.match(r'Error: (.*?) \(\{', e.get('message', ''))
                    errors[(label, project, m.group(1) if m else e.get('message', '').splitlines()[0][:120])] += 1
                for a in result.get('attachments', []):
                    if not a['name'].startswith('geometry: ') or 'body' not in a:
                        continue
                    g = json.loads(base64.b64decode(a['body']))
                    step = a['name'].removeprefix('geometry: ')
                    # The exploratory runs' spec compared the list with the toolbar's bottom, not the bar's.
                    list_off = 'barBottom' in g and abs(g['listTop'] - (g['barBottom'] + g['toolbarMargin'])) >= 0.5
                    off = abs(g['toolbar'] - g['bar']) >= 0.5 or list_off
                    key = (label, project, step)
                    entry = steps.setdefault(key, {'off': 0, 'runs': 0, 'toolbar': collections.Counter(), 'bar': collections.Counter()})
                    entry['off'] += off
                    entry['runs'] += 1
                    entry['toolbar'][g['toolbar']] += 1
                    entry['bar'][g['bar']] += 1
print(f"{'tree':5} {'project':22} {'step':34} off/runs  toolbar heights        bar heights")
for (label, project, step), e in sorted(steps.items()):
    print(f"{label:5} {project:22} {step:34} {e['off']:>3}/{e['runs']:<4} {dict(e['toolbar'])!s:22} {dict(e['bar'])}")
print()
for (label, project, status), n in sorted(outcomes.items()):
    print(f"{label:5} {project:22} tests {status}: {n}")
print()
for (label, project, message), n in sorted(errors.items()):
    print(f"{label:5} {project:22} {n:>3} x {message}")
if out:
    json.dump({'steps': [{'tree': l, 'project': p, 'step': s, 'off': e['off'], 'runs': e['runs'],
                          'toolbarHeights': {str(k): v for k, v in e['toolbar'].items()}, 'barHeights': {str(k): v for k, v in e['bar'].items()}}
                         for (l, p, s), e in sorted(steps.items())],
               'tests': [{'tree': l, 'project': p, 'status': s, 'count': n} for (l, p, s), n in sorted(outcomes.items())],
               'errors': [{'tree': l, 'project': p, 'message': m, 'count': n} for (l, p, m), n in sorted(errors.items())]},
              open(out, 'w'), indent=1)
