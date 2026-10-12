"""report.summary.json from a Playwright JSON report: the report as written, minus attachment bodies.

Usage: python3 -I summarize-report.py <report.json> <report.summary.json>

Every test result keeps its title path, project, status, duration, retry, errors and attachment names,
content types and paths; only the inline `body` of attachments is dropped (project evidence-size rule,
2026-10-07). Prints the per-status counts it saw.
"""
import collections
import json
import sys

report = json.load(open(sys.argv[1]))
counts = collections.Counter()


def walk(suite):
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            for result in test['results']:
                counts[result['status']] += 1
                for attachment in result.get('attachments', []):
                    attachment.pop('body', None)
    for child in suite.get('suites', []):
        walk(child)


for suite in report['suites']:
    walk(suite)
with open(sys.argv[2], 'w') as out:
    json.dump(report, out, indent=1, ensure_ascii=False)
    out.write('\n')
print(dict(counts), json.dumps(report.get('stats')))
