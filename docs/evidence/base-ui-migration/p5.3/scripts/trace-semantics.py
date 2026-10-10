#!/usr/bin/env python3
"""Compare what each step of two P5.3 runs did, field by field.

usage: trace-semantics.py REF_REPORT.json DEL_REPORT.json > OUT.json

For every test both runs attached a `trace` to (p53.browser.mjs observe(): each step's address, focus, the composer's
state — value, selection, placeholder, height, whether it scrolls, shell mode, the mirror's chips, the attachments, its
own menu, Send/Stop, the +, the model chip and the pickers — the conversation's rows in order, the queued bubbles, the
distance to the tail, the session list's rows, the header's title, the open menus' items (disabled, selected,
submenu, ✓, native tip), the open lists' options, the dialogs (role, title, words, buttons), the popovers' and tips'
words, the find field, the scroll lock, the requests sent with their bodies, and the runtime census of AntD-classed
elements), step by step:
- `semantic`: every field but the census; any difference is listed, and the exit code is 1 if there is one.
- `antd`: per run, the steps whose census found AntD-classed elements, and which classes.
Only reads.
"""
import base64
import json
import sys


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
out = {'tests': len(set(ref) | set(dele)), 'steps': 0, 'semantic': [], 'antd': {'ref': {}, 'del': {}}, 'missing': []}
for key in sorted(set(ref) | set(dele)):
    if key not in ref or key not in dele:
        out['missing'].append({'test': key, 'ref': key in ref, 'del': key in dele})
        continue
    r, d = ref[key], dele[key]
    if len(r) != len(d):
        out['semantic'].append({'test': key, 'lengths': [len(r), len(d)]})
    for index, (rs, ds) in enumerate(zip(r, d)):
        out['steps'] += 1
        rstep, dstep = dict(rs), dict(ds)
        rantd, dantd = rstep.pop('antd', None), dstep.pop('antd', None)
        if rstep != dstep:
            fields = sorted(k for k in set(rstep) | set(dstep) if rstep.get(k) != dstep.get(k))
            out['semantic'].append({'test': key, 'index': index, 'step': rs.get('step'), 'fields': {k: [rstep.get(k), dstep.get(k)] for k in fields}})
        for side, antd in (('ref', rantd), ('del', dantd)):
            if antd:
                out['antd'][side].setdefault(key, []).append({'step': rs.get('step'), 'classes': antd})
out['antd'] = {side: {'tests': len(v), 'steps': sum(len(x) for x in v.values()), 'classes': sorted({c for x in v.values() for s in x for c in s['classes']})}
               for side, v in out['antd'].items()}
json.dump(out, sys.stdout, indent=1, ensure_ascii=False, sort_keys=True)
print()
sys.exit(1 if out['semantic'] or out['missing'] else 0)
