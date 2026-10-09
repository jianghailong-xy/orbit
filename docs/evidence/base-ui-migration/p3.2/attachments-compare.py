#!/usr/bin/env python3
"""Compare the attachments two runs of the same spec recorded: usage attachments-compare.py REF_REPORT DEL_REPORT > out.json

For every (environment, test, attachment name) both Playwright JSON reports list: JSON attachments are
compared value by value (the differing paths are listed), PNG attachments pixel by pixel (equal bytes,
or the differing pixel count, how many are within 2 per channel, and the largest channel difference).
Used for reviews.check.mjs, which records each review dialog's geometry and screenshot. Reads only."""
import base64
import io
import json
import sys
from PIL import Image


def attachments(report_path):
    report = json.load(open(report_path))
    found = {}

    def walk(suite, prefix):
        for child in suite.get('suites', []):
            walk(child, prefix + [child['title']])
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                for result in test['results']:
                    for attachment in result.get('attachments', []):
                        if attachment.get('contentType') not in ('application/json', 'image/png') or 'path' not in attachment and 'body' not in attachment:
                            continue
                        key = (test['projectName'], ' › '.join(prefix[1:] + [spec['title']]), attachment['name'])
                        found[key] = attachment
    for suite in report['suites']:
        walk(suite, [suite['title']])
    return found


def read(attachment):
    if 'body' in attachment:
        return base64.b64decode(attachment['body'])
    return open(attachment['path'], 'rb').read()


def differences(a, b, path=''):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b)):
            out += differences(a.get(key), b.get(key), f'{path}.{key}' if path else key)
        return out
    if isinstance(a, list) and isinstance(b, list) and len(a) == len(b):
        out = []
        for index, (x, y) in enumerate(zip(a, b)):
            out += differences(x, y, f'{path}[{index}]')
        return out
    return [] if a == b else [{'path': path, 'ref': a, 'del': b}]


def pixels(a_bytes, b_bytes):
    if a_bytes == b_bytes:
        return {'equal': True}
    a, b = Image.open(io.BytesIO(a_bytes)).convert('RGBA'), Image.open(io.BytesIO(b_bytes)).convert('RGBA')
    if a.size != b.size:
        return {'equal': False, 'sizeRef': a.size, 'sizeDel': b.size}
    pa, pb = a.load(), b.load()
    diffs = [max(abs(pa[x, y][i] - pb[x, y][i]) for i in range(4)) for y in range(a.size[1]) for x in range(a.size[0]) if pa[x, y] != pb[x, y]]
    return {'equal': False, 'pixels': len(diffs), 'pixelsAtMost2': sum(1 for d in diffs if d <= 2), 'maxChannelDiff': max(diffs, default=0)}


ref, delivered = attachments(sys.argv[1]), attachments(sys.argv[2])
result = {}
for key in sorted(set(ref) & set(delivered)):
    label = ' :: '.join(key)
    r, d = ref[key], delivered[key]
    if r['contentType'] == 'application/json':
        delta = differences(json.loads(read(r)), json.loads(read(d)))
        result[label] = {'kind': 'json', 'equal': not delta, 'differences': delta[:40]}
    else:
        result[label] = {'kind': 'png', **pixels(read(r), read(d))}
result['_missing'] = {'onlyReference': [' :: '.join(k) for k in sorted(set(ref) - set(delivered))],
                      'onlyDelivery': [' :: '.join(k) for k in sorted(set(delivered) - set(ref))]}
json.dump(result, sys.stdout, indent=1)
print()
