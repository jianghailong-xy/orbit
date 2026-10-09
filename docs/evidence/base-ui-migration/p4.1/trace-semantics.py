#!/usr/bin/env python3
"""Compare what each step of two runs' traces did, not how focus looked: for every test both runs
attached a `trace` to, step by step, the address, the requests sent (method, path, body), the
notifications shown, the table rows read and the states the steps recorded (checkboxes, switches, theme,
saved preference, password field type). Prints the tests compared and every step where any of these
differ, and exits 1 if there is one.

usage: trace-semantics.py REF_REPORT.json DEL_REPORT.json
"""
import base64, json, sys

FIELDS = ('url', 'requests', 'notifications', 'rows', 'boxes', 'switches', 'theme', 'saved', 'passwordType', 'step')


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
                            found[(test['projectName'], ' › '.join(prefix[1:] + [spec['title']]))] = json.loads(base64.b64decode(attachment['body']))
    for suite in json.load(open(path))['suites']:
        walk(suite, [suite['title']])
    return found


ref, dele = traces(sys.argv[1]), traces(sys.argv[2])
differences = []
for key in sorted(set(ref) | set(dele)):
    r, d = ref.get(key), dele.get(key)
    if r is None or d is None:
        differences.append({'test': key, 'missing': 'ref' if r is None else 'del'})
        continue
    if len(r) != len(d):
        differences.append({'test': key, 'steps': [len(r), len(d)]})
    for rs, ds in zip(r, d):
        delta = {field: [rs.get(field), ds.get(field)] for field in FIELDS if rs.get(field) != ds.get(field)}
        if delta:
            differences.append({'test': key, 'step': rs.get('step'), 'delta': delta})
print(json.dumps({'tests': len(set(ref) & set(dele)), 'steps': sum(len(t) for t in ref.values()), 'differences': differences}, indent=1, ensure_ascii=False))
sys.exit(1 if differences else 0)
