#!/usr/bin/env python3
"""Usage: states.py <run-label> -> writes runs/<label>/states.json: {project/screenshot: state} from the report attachments."""
import base64, json, sys
run = f'/var/tmp/p23b1/runs/{sys.argv[1]}'
r = json.load(open(f'{run}/output/report.json'))
out = {}
def visit(s):
    for sp in s.get('specs', []):
        for t in sp['tests']:
            for res in t['results']:
                for a in res.get('attachments', []):
                    if a['name'].endswith('-b1-state') and a.get('body'):
                        st = json.loads(base64.b64decode(a['body']))
                        out[f"{t['projectName']}/{st['screenshot']}.png"] = st
    for c in s.get('suites', []): visit(c)
for s in r['suites']: visit(s)
json.dump(out, open(f'{run}/states.json', 'w'), indent=1)
print(len(out), 'states')
