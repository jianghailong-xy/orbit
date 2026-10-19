#!/usr/bin/env python3
"""Usage: scroll-records.py <report.json> <out.json>

From a run of overlays-app-frame.browser.mjs: per project and test, its status, its soft-assertion errors
(first line each) and the JSON it attached (the document before/after a notice, or the page's scroll
position at each step), so the evidence keeps the measurements while report.summary.json drops bodies."""
import base64, json, re, sys
ANSI = re.compile(r'\x1b\[[0-9;]*m')
r = json.load(open(sys.argv[1]))
rows = []
def walk(suite):
    for s in suite.get('suites', []): yield from walk(s)
    for spec in suite.get('specs', []):
        if 'overlays-app-frame' not in spec.get('file', ''): continue
        for t in spec['tests']:
            yield spec['title'], t
for suite in r['suites']:
    for title, t in walk(suite):
        for res in t['results']:
            data = {}
            for a in res.get('attachments', []):
                if a.get('contentType') == 'application/json' and a.get('body'):
                    data[a['name']] = json.loads(base64.b64decode(a['body']).decode())
            rows.append({'project': t['projectName'], 'test': title, 'status': res['status'], 'retry': res.get('retry', 0),
                         'errors': [' / '.join(ANSI.sub('', e.get('message') or '').split('\n')[:4]) for e in res.get('errors', [])], **data})
json.dump(rows, open(sys.argv[2], 'w'), indent=1)
open(sys.argv[2], 'a').write('\n')
print(sys.argv[2], len(rows), 'results')
