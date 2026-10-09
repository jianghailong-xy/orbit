#!/usr/bin/env python3
"""Usage: extract-traces.py REPORT.json OUT.json

Every `trace` attachment (p41.browser.mjs: each step's address, focus, open dialogs, invalid fields
with what describes them, alerts, notifications and the requests sent) of a Playwright JSON report,
keyed `project :: test`, so a run's step-by-step observations stay readable once the report is
stripped of attachment bodies (report-summary.py)."""
import base64, json, sys

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


for suite in json.load(open(sys.argv[1]))['suites']:
    walk(suite, [suite['title']])
json.dump(dict(sorted(found.items())), open(sys.argv[2], 'w'), indent=1, ensure_ascii=False)
open(sys.argv[2], 'a').write('\n')
print(sys.argv[2], len(found), 'traces')
