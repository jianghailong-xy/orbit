#!/usr/bin/env python3
"""Compare what each step of two P4.3b runs did, apart from how focus and layers present themselves.

usage: trace-semantics.py REF_REPORT.json DEL_REPORT.json > OUT.json

For every test both runs attached a `trace` to (p43b-helpers.mjs observe(): each step's address,
focus, open modal dialogs, floating popups and tooltips, alerts, notifications and the requests the
step sent, plus what a step measured itself), step by step:
- `semantic`: the step name, the address, the notifications, the alerts, the layers open (the words of
  every open dialog, popup or tooltip, together: observe() files a layer under `dialogs` when it is
  aria-modal or inside the replaced modal's wrap, and Base UI's modal dialogs mark the page around
  them aria-hidden instead of carrying aria-modal, so the same dialog lands under `dialogs` on one
  tree and `popups` on the other), the writes the step sent (method, path, body: every request but
  GET), and a step's own measurements: a field's value, a note kept across closing, the start card's
  settings, whether a drag panned a graph, and the graph's geometry (strip, marks, zoom toolbar,
  full-screen button, marks running past the strip, marks over the toolbar), equal to 0.01px. Any
  difference is listed; the exit code is 1 if there is one.
- `reads`: the GET requests of each test as a multiset over all its steps (a background read lands
  in whichever step is observing when it is sent); tests whose reads differ are listed.
- `presentation`: focus, and where observe() filed the layers (dialogs or popups), counted, with the
  first examples. Focus follows the component conventions already accepted in P2/P3 (where focus
  lands when a layer opens or closes).
Only reads.
"""
import base64
import json
import sys

SEMANTIC = ('step', 'url', 'notifications', 'alerts', 'note', 'check', 'count', 'panned')
PRESENTATION = ('focus', 'filed')


def rounded(value):
    if isinstance(value, float):
        return round(value, 2)
    if isinstance(value, dict):
        return {key: rounded(item) for key, item in value.items()}
    if isinstance(value, list):
        return [rounded(item) for item in value]
    return value


def traces(path):
    found = {}

    def walk(suite, prefix):
        for child in suite.get('suites', []):
            walk(child, prefix + [child['title']])
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    for attachment in result.get('attachments', []):
                        if attachment['name'] == 'trace' and attachment.get('contentType') == 'application/json' and 'body' in attachment:
                            found[f"{test['projectName']} :: {' › '.join(prefix[1:] + [spec['title']])}"] = json.loads(base64.b64decode(attachment['body']))
    for suite in json.load(open(path))['suites']:
        walk(suite, [suite['title']])
    return found


ref, dele = traces(sys.argv[1]), traces(sys.argv[2])


def layers(step):
    return sorted(text for text in (step.get('dialogs') or []) + (step.get('popups') or []) if text)


def writes(step):
    return [{k: r.get(k) for k in ('method', 'path', 'body')} for r in step.get('requests') or [] if r.get('method') != 'GET']


def reads(steps):
    from collections import Counter
    return Counter(r.get('path') for step in steps for r in step.get('requests') or [] if r.get('method') == 'GET')


def filed(step):
    return {'dialogs': len([t for t in step.get('dialogs') or [] if t]), 'popups': len([t for t in step.get('popups') or [] if t])}


semantic, presentation, examples, read_deltas = [], {field: 0 for field in PRESENTATION}, {field: [] for field in PRESENTATION}, []
for key in sorted(set(ref) | set(dele)):
    r, d = ref.get(key), dele.get(key)
    if r is None or d is None:
        semantic.append({'test': key, 'missing': 'ref' if r is None else 'del'})
        continue
    if len(r) != len(d):
        semantic.append({'test': key, 'steps': [len(r), len(d)]})
    for rs, ds in zip(r, d):
        delta = {field: [rs.get(field), ds.get(field)] for field in SEMANTIC if rs.get(field) != ds.get(field)}
        if layers(rs) != layers(ds):
            delta['layers'] = [layers(rs), layers(ds)]
        if writes(rs) != writes(ds):
            delta['writes'] = [writes(rs), writes(ds)]
        for field in ('geometry', 'field'):
            if rounded(rs.get(field)) != rounded(ds.get(field)):
                delta[field] = [rs.get(field), ds.get(field)]
        if delta:
            semantic.append({'test': key, 'step': rs.get('step'), 'delta': delta})
        for field, (a, b) in (('focus', (rs.get('focus'), ds.get('focus'))), ('filed', (filed(rs), filed(ds)))):
            if a != b:
                presentation[field] += 1
                if len(examples[field]) < 16:
                    examples[field].append({'test': key, 'step': rs.get('step'), 'ref': a, 'del': b})
    ra, da = reads(r), reads(d)
    if ra != da:
        read_deltas.append({'test': key, 'refOnly': dict(ra - da), 'delOnly': dict(da - ra)})
both = set(ref) & set(dele)
json.dump({'tests': len(both), 'steps': sum(len(ref[key]) for key in both), 'semantic': semantic, 'reads': read_deltas,
           'presentation': presentation, 'examples': examples}, sys.stdout, indent=1, ensure_ascii=False)
print()
sys.exit(1 if semantic else 0)
