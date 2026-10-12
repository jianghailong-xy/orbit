#!/usr/bin/env python3
"""failures.py REPORT.json...: each failed test of the Playwright JSON reports, as `project :: file › title :: reason`,
the reason being the first line of the error message (colour codes removed) or, for the fixture check, the unhandled
calls. Prints one line per failure and a count per reason."""
import collections, json, re, sys

def walk(suite, prefix):
    for child in suite.get('suites', []): yield from walk(child, prefix + [child['title']])
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            for result in test['results']:
                if result['status'] in ('passed', 'skipped'): continue
                message = re.sub(r'\x1b\[[0-9;]*m', '', (result.get('error') or {}).get('message') or '')
                calls = sorted(set(re.findall(r"'((?:GET|POST|PATCH|PUT|DELETE) [^']+)'", message)))
                reason = 'unhandled: ' + ', '.join(calls) if 'explicit browser fixture' in message else message.strip().split('\n')[0][:140]
                yield test['projectName'], ' › '.join(prefix[1:] + [spec['title']]), reason

for path in sys.argv[1:]:
    rows = [row for suite in json.load(open(path))['suites'] for row in walk(suite, [suite['title']])]
    print(f'== {path}: {len(rows)} failed')
    for project, title, reason in sorted(rows): print(f'{project} :: {title} :: {reason}')
    for reason, n in collections.Counter(r for _, _, r in rows).most_common(): print(f'   {n} × {reason}')
