#!/usr/bin/env python3
"""The original (pre-P6) fixture specs' reds on two trees, test by test: every (spec, title, project) that did not pass
on either, its status on both, and whether its error messages are the same on both once each tree's own checkout path
and terminal colours are set aside.

usage: preexisting-reds.py A=A_REPORT.json B=B_REPORT.json > reds.json   (the names label the two trees)

Exits 1 if the two trees' reds are not the same tests with the same messages. Reads only.
"""
import json
import re
import sys


def results(path):
    report = json.load(open(path))
    found = {}

    def clean(message):
        message = re.sub(r'\x1b\[[0-9;]*m', '', message)
        return re.sub(r'/\S*?/src/web/', '<tree>/src/web/', message)

    def walk(suite, file):
        file = suite.get('file', file)
        for child in suite.get('suites', []):
            walk(child, file)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                result = test['results'][-1] if test['results'] else {}
                found[f"{file} › {spec['title']} › {test['projectName']}"] = {
                    'status': result.get('status'), 'errors': [clean(error.get('message', '')) for error in result.get('errors', [])]}
    for suite in report['suites']:
        walk(suite, suite.get('file'))
    return found


(a_name, a_path), (b_name, b_path) = (argument.split('=', 1) for argument in sys.argv[1:3])
a, b = results(a_path), results(b_path)
counts = {name: {} for name in (a_name, b_name)}
for name, side in ((a_name, a), (b_name, b)):
    for entry in side.values():
        counts[name][entry['status']] = counts[name].get(entry['status'], 0) + 1
reds = sorted(key for key in set(a) | set(b) if (a.get(key) or {}).get('status') not in ('passed', 'skipped')
              or (b.get(key) or {}).get('status') not in ('passed', 'skipped'))
rows = []
for key in reds:
    x, y = a.get(key) or {}, b.get(key) or {}
    rows.append({'test': key, a_name: x.get('status'), b_name: y.get('status'), 'sameMessages': x.get('errors') == y.get('errors'),
                 'firstMessage': (x.get('errors') or y.get('errors') or [''])[0][:600]})
same = all(row[a_name] == row[b_name] and row['sameMessages'] for row in rows)
print(json.dumps({'tests': counts, 'reds': len(rows), 'sameOnBoth': same, 'rows': rows}, indent=1, ensure_ascii=False))
sys.exit(0 if same else 1)
