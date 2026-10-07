"""The `trace` attachment of every result of one pilot case, by project, from a Playwright JSON report.

Usage: python3 -I extract-traces.py <report.json> <case title> <out.json>

The pilot attaches each case's per-step observations as `trace`; report.summary.json drops attachment
bodies, so the traces a README cites are kept here instead. Inline bodies are base64; others are read
from their path.
"""
import base64
import json
import sys

report_path, title, out_path = sys.argv[1:4]
report = json.load(open(report_path))
found = {}


def walk(suite):
    for spec in suite.get('specs', []):
        if spec['title'] != title:
            continue
        for test in spec['tests']:
            for result in test['results']:
                for attachment in result.get('attachments', []):
                    if attachment['name'] != 'trace':
                        continue
                    body = base64.b64decode(attachment['body']).decode() if 'body' in attachment else open(attachment['path']).read()
                    found[test['projectName']] = {'status': result['status'], 'retry': result['retry'], 'trace': json.loads(body)}
    for child in suite.get('suites', []):
        walk(child)


for suite in report['suites']:
    walk(suite)
with open(out_path, 'w') as out:
    json.dump(dict(sorted(found.items())), out, indent=1, ensure_ascii=False)
    out.write('\n')
print(len(found), 'projects:', {project: row['status'] for project, row in sorted(found.items())})
