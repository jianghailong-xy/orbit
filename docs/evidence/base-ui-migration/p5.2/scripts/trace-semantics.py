#!/usr/bin/env python3
"""Compare what each step of two P5.2 runs did, field by field.

usage: trace-semantics.py REF_REPORT.json DEL_REPORT.json > OUT.json

For every test both runs attached a `trace` to (p52.browser.mjs observe(): each step's address, focus, the viewer's
state, the scroll lock, the pictures and placeholders drawn, the chips, the scroller, the object URLs, the requests
sent and the runtime census of AntD-classed elements in the conversation, the composer's attachments and the viewer),
step by step:
- `semantic`: everything a reader or the server sees: the step, the address, the focus (the viewer's buttons under the
  Orbit names, observe()'s NAMES), the viewer (position, picture, transform, the picture's box, the buttons and which
  are disabled), the scroll lock, the pictures (where, which, its class, whether it opens the group or on its own, its
  box), the placeholders, the chips, the scroller, the object URLs, the requests (and whether each carried the bearer),
  and the steps' own extras (the keyboard order, the rows' order, a gesture's touch support, the URLs not revoked).
  Any difference is listed; the exit code is 1 if there is one.
- `antd`: per run, the steps whose census found AntD-classed elements, and which classes.
- `presentation`: the viewer's accessible name, counted, with the first examples: the replaced viewer had none for a
  group and the picture's alt alone; the Orbit one names itself by the picture's alt, or "Image preview".
Only reads.
"""
import base64
import json
import sys

PRESENTATION = ('viewerName',)


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


def split(step):
    step = dict(step)
    antd = step.pop('antd', None)
    viewer = step.get('viewer')
    name = None
    if isinstance(viewer, dict):
        viewer = dict(viewer)
        name = viewer.pop('name', None)
        step['viewer'] = viewer
    return step, antd, name


ref, dele = traces(sys.argv[1]), traces(sys.argv[2])
out = {'tests': len(set(ref) | set(dele)), 'steps': 0, 'semantic': [], 'antd': {'ref': {}, 'del': {}}, 'presentation': {'viewerName': {'differing': 0, 'examples': []}}, 'missing': []}
for key in sorted(set(ref) | set(dele)):
    if key not in ref or key not in dele:
        out['missing'].append({'test': key, 'ref': key in ref, 'del': key in dele})
        continue
    r, d = ref[key], dele[key]
    if len(r) != len(d):
        out['semantic'].append({'test': key, 'lengths': [len(r), len(d)]})
    for index, (rs, ds) in enumerate(zip(r, d)):
        out['steps'] += 1
        rstep, rantd, rname = split(rs)
        dstep, dantd, dname = split(ds)
        if rstep != dstep:
            fields = sorted(k for k in set(rstep) | set(dstep) if rstep.get(k) != dstep.get(k))
            out['semantic'].append({'test': key, 'index': index, 'step': rs.get('step'), 'fields': {k: [rstep.get(k), dstep.get(k)] for k in fields}})
        for side, antd in (('ref', rantd), ('del', dantd)):
            if antd:
                out['antd'][side].setdefault(key, []).append({'step': rs.get('step'), 'classes': antd})
        if rname != dname:
            p = out['presentation']['viewerName']
            p['differing'] += 1
            if len(p['examples']) < 6:
                p['examples'].append({'test': key, 'step': rs.get('step'), 'ref': rname, 'del': dname})
out['antd'] = {side: {'tests': len(v), 'steps': sum(len(x) for x in v.values()), 'classes': sorted({c for x in v.values() for s in x for c in s['classes']}), 'first': [dict(test=k, **x[0]) for k, x in list(v.items())[:3]]} for side, v in out['antd'].items()}
json.dump(out, sys.stdout, indent=1, ensure_ascii=False, sort_keys=True)
print()
sys.exit(1 if out['semantic'] or out['missing'] else 0)
