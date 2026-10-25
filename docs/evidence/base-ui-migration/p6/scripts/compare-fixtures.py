#!/usr/bin/env python3
"""The Orbit side before and after P6: two runs of the same (delivered) fixture specs, on the start tree and on the
delivery, compared test by test and attachment by attachment.

usage: compare-fixtures.py BEFORE_REPORT AFTER_REPORT > compare.json

For every test (spec file, title, project) in either report: both statuses. For every attachment both runs wrote
under the same name: JSON bodies compared value by value (the paths that differ, with both values), PNG bodies
compared pixel by pixel (equal bytes, or how many pixels differ and by how much). Reads only.
"""
import base64
import io
import json
import sys

from PIL import Image


def tests(path):
    report = json.load(open(path))
    found = {}

    def walk(suite, file):
        file = suite.get('file', file)
        for child in suite.get('suites', []):
            walk(child, file)
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                result = test['results'][-1] if test['results'] else {}
                found[(file, spec['title'], test['projectName'])] = {
                    'status': result.get('status'), 'expected': test.get('expectedStatus'),
                    'attachments': {a['name']: a for a in result.get('attachments', []) if a.get('body')},
                }
    for suite in report['suites']:
        walk(suite, suite.get('file'))
    return found


def json_diff(a, b, path=''):
    if isinstance(a, dict) and isinstance(b, dict):
        out = []
        for key in sorted(set(a) | set(b), key=str):
            out += json_diff(a.get(key, '<absent>'), b.get(key, '<absent>'), f'{path}.{key}' if path else str(key))
        return out
    if isinstance(a, list) and isinstance(b, list):
        out = [] if len(a) == len(b) else [{'path': f'{path}.length', 'before': len(a), 'after': len(b)}]
        for i, (x, y) in enumerate(zip(a, b)):
            out += json_diff(x, y, f'{path}[{i}]')
        return out
    return [] if a == b else [{'path': path, 'before': a, 'after': b}]


def png_diff(a, b):
    if a == b:
        return {'equal': True}
    ia, ib = Image.open(io.BytesIO(a)).convert('RGBA'), Image.open(io.BytesIO(b)).convert('RGBA')
    if ia.size != ib.size:
        return {'equal': False, 'sizes': [ia.size, ib.size]}
    pa, pb = ia.load(), ib.load()
    deltas = [max(abs(pa[x, y][i] - pb[x, y][i]) for i in range(4)) for y in range(ia.size[1]) for x in range(ia.size[0]) if pa[x, y] != pb[x, y]]
    return {'equal': False, 'pixels': len(deltas), 'maxChannelDiff': max(deltas) if deltas else 0}


before, after = tests(sys.argv[1]), tests(sys.argv[2])
out = {'tests': {}, 'totals': {'tests': 0, 'bothPassed': 0, 'statusDiffers': 0, 'onlyBefore': 0, 'onlyAfter': 0,
                                'jsonAttachments': 0, 'jsonDiffering': 0, 'pngAttachments': 0, 'pngEqual': 0, 'pngDiffering': 0}}
t = out['totals']
for key in sorted(set(before) | set(after)):
    b, a = before.get(key), after.get(key)
    name = ' › '.join(key)
    t['tests'] += 1
    if not b or not a:
        t['onlyBefore' if b else 'onlyAfter'] += 1
        out['tests'][name] = {'before': b and b['status'], 'after': a and a['status']}
        continue
    entry = {'before': b['status'], 'after': a['status'], 'attachments': {}}
    if b['status'] == a['status'] == 'passed':
        t['bothPassed'] += 1
    elif b['status'] != a['status']:
        t['statusDiffers'] += 1
    else:
        t['sameStatusNotPassed'] = t.get('sameStatusNotPassed', 0) + 1
    for attachment in sorted(set(b['attachments']) & set(a['attachments'])):
        x, y = base64.b64decode(b['attachments'][attachment]['body']), base64.b64decode(a['attachments'][attachment]['body'])
        kind = b['attachments'][attachment].get('contentType', '')
        if kind == 'application/json':
            t['jsonAttachments'] += 1
            differences = json_diff(json.loads(x), json.loads(y))
            if differences:
                t['jsonDiffering'] += 1
                entry['attachments'][attachment] = {'differences': len(differences), 'sample': differences[:20]}
        elif kind == 'image/png':
            t['pngAttachments'] += 1
            result = png_diff(x, y)
            t['pngEqual' if result['equal'] else 'pngDiffering'] += 1
            if not result['equal']:
                entry['attachments'][attachment] = result
    out['tests'][name] = entry
print(json.dumps(out, indent=1, ensure_ascii=False, default=str))
