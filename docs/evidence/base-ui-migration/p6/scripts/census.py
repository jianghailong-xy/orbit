#!/usr/bin/env python3
"""The batch tools' runtime census on one tree: every `antd` field (the [class*="ant-"] classes a step drew, the icons'
anticon excepted) in the JSON attachments of each Playwright report given.

usage: census.py NAME=REPORT.json... > census.json

For each report: its tests by status, how many steps recorded a census, how many of those drew any class, and every
class drawn with the number of steps that drew it. Reads only.
"""
import base64
import collections
import json
import sys


def fields(value):
    if isinstance(value, dict):
        for key, inner in value.items():
            if key == 'antd' and isinstance(inner, list):
                yield inner
            else:
                yield from fields(inner)
    elif isinstance(value, list):
        for inner in value:
            yield from fields(inner)


out = {}
for argument in sys.argv[1:]:
    name, path = argument.split('=', 1)
    report = json.load(open(path))
    statuses, classes = collections.Counter(), collections.Counter()
    steps = drawing = 0

    def walk(suite):
        global steps, drawing
        for child in suite.get('suites', []):
            walk(child)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                result = test['results'][-1] if test['results'] else {}
                statuses[result.get('status', 'none')] += 1
                for attachment in result.get('attachments', []):
                    if attachment.get('contentType') != 'application/json' or not attachment.get('body'):
                        continue
                    for census in fields(json.loads(base64.b64decode(attachment['body']))):
                        steps += 1
                        drawing += bool(census)
                        classes.update(set(census))
    for suite in report['suites']:
        walk(suite)
    out[name] = {'tests': dict(statuses), 'stepsWithCensus': steps, 'stepsDrawingAnyClass': drawing, 'classes': dict(classes.most_common())}
print(json.dumps(out, indent=1))
