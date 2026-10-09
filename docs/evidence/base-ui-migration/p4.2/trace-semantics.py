#!/usr/bin/env python3
"""Compare what each step of two P4.2 runs did, apart from how focus and layers present themselves.

usage: trace-semantics.py REF_REPORT.json DEL_REPORT.json > OUT.json

For every test both runs attached a `trace` to (p42.browser.mjs observe(): each step's address, focus,
open dialogs and menus, alerts, notifications and the requests the step sent), step by step:
- `semantic`: the step name, the address, the requests (method, path, body), the notifications, the
  open menus' items (text, disabled) and the alerts, and where a step records them, the type of the
  field showing a stored key and the top-up link (tag, href, target, rel). Any difference is listed;
  the exit code is 1 if there is one.
- `presentation`: focus and the open dialogs' text, counted per field, with the first examples. These
  follow the component conventions already accepted in P2/P3 (where focus lands when a layer opens or
  closes; an anchored question is a dialog where the replaced one was a tooltip).
Only reads.
"""
import base64
import json
import sys

SEMANTIC = ('step', 'url', 'requests', 'notifications', 'menus', 'alerts', 'type', 'topUp')
PRESENTATION = ('focus', 'dialogs')


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
semantic, presentation, examples = [], {field: 0 for field in PRESENTATION}, {field: [] for field in PRESENTATION}
for key in sorted(set(ref) | set(dele)):
    r, d = ref.get(key), dele.get(key)
    if r is None or d is None:
        semantic.append({'test': key, 'missing': 'ref' if r is None else 'del'})
        continue
    if len(r) != len(d):
        semantic.append({'test': key, 'steps': [len(r), len(d)]})
    for rs, ds in zip(r, d):
        delta = {field: [rs.get(field), ds.get(field)] for field in SEMANTIC if rs.get(field) != ds.get(field)}
        if delta:
            semantic.append({'test': key, 'step': rs.get('step'), 'delta': delta})
        for field in PRESENTATION:
            if rs.get(field) != ds.get(field):
                presentation[field] += 1
                if len(examples[field]) < 12:
                    examples[field].append({'test': key, 'step': rs.get('step'), 'ref': rs.get(field), 'del': ds.get(field)})
both = set(ref) & set(dele)
json.dump({'tests': len(both), 'steps': sum(len(ref[key]) for key in both), 'semantic': semantic,
           'presentation': presentation, 'examples': examples}, sys.stdout, indent=1, ensure_ascii=False)
print()
sys.exit(1 if semantic else 0)
