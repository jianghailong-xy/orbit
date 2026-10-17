#!/usr/bin/env python3
"""Every attachment that differs between the base's and the delivery's run of the delivered fixture specs, put beside the
same attachment in two runs of the delivery (compare-fixtures.py outputs), and grouped:

- noise: it also differs between the two delivery runs, so a run of the same tree moves it (timing, motion frames);
  noise-kind: a JSON attachment that is the same on both delivery runs in this test, but every path it differs on also
  differs between the two delivery runs in an attachment of the same kind (name) elsewhere: the same timing fields;
- layout-json: a JSON attachment that is the same on both delivery runs and whose differences from the base are all page
  positions (x/y/top/bottom/left/right, page scroll), each the same offset within the attachment, or the composer
  replica's toolbar (its buttons are the page's Orbit ones on the delivery, see README);
- stable-png: a screenshot that is the same on both delivery runs and differs from the base's: listed with where its
  pixels differ (the box) for review against what the fixture commit removed or moved;
- anything else is listed as unexplained (exit 1).

usage: classify-fixture-diffs.py DIR CONFIG...   (DIR holds CONFIG.json, base vs delivery, and CONFIG.noise.json, delivery
       vs delivery; the PNG boxes are read from the reports named in REPORTS below)
"""
import base64
import io
import json
import re
import sys
from collections import Counter, defaultdict

from PIL import Image, ImageChops

directory, configs = sys.argv[1], sys.argv[2:]
RUNS = '/mnt/data/tmp/34Za39RS6A28G7xPqMD0p/v1/f1'
POSITION = re.compile(r'(^|\.)(x|y|top|bottom|left|right|pageScrollTop|scrollTop)$')
TOOLBAR = re.compile(r'(toolbar\.(height|y)|box\.(height|y)|composerField\.y|content\.top|field\.y|mirror\.y|thumbnails\[\d+\]\.y|attachments\.y)$')


def reports(config):
    found = {}
    for tree in ('base', 'del'):
        report = json.load(open(f'{RUNS}/fixtures-{tree}-{config}-out/report.json'))

        def walk(suite, file):
            file = suite.get('file', file)
            for child in suite.get('suites', []):
                walk(child, file)
            for spec in suite.get('specs', []):
                for test in spec['tests']:
                    result = test['results'][-1] if test['results'] else {}
                    for attachment in result.get('attachments', []):
                        if attachment.get('body') and attachment.get('contentType') == 'image/png':
                            found[(tree, f"{file} › {spec['title']} › {test['projectName']}", attachment['name'])] = attachment['body']
        for suite in report['suites']:
            walk(suite, suite.get('file'))
    return found


out = {'configs': {}, 'unexplained': []}
for config in configs:
    pair = json.load(open(f'{directory}/{config}.json'))
    noise = json.load(open(f'{directory}/{config}.noise.json'))
    pngs = None
    groups = defaultdict(lambda: Counter())
    shape = lambda path: re.sub(r'\[\d+\]', '[*]', path)
    noisy_paths = defaultdict(set)
    for entry in noise['tests'].values():
        for name, attachment in entry.get('attachments', {}).items():
            for difference in attachment.get('sample', []):
                noisy_paths[re.sub(r'\d+', '#', name)].add(shape(difference['path']))
    stable_pngs = []
    for test, entry in pair['tests'].items():
        noisy = noise['tests'].get(test, {}).get('attachments', {})
        for name, attachment in entry.get('attachments', {}).items():
            kind = 'json' if 'differences' in attachment else 'png'
            label = re.sub(r'\d+', '#', name)
            if name in noisy:
                groups[label][f'{kind}:noise'] += 1
                continue
            if kind == 'json':
                paths = [d['path'] for d in attachment['sample']]
                offsets = {d['after'] - d['before'] for d in attachment['sample'] if isinstance(d['before'], (int, float)) and isinstance(d['after'], (int, float))}
                if attachment['differences'] == len(attachment['sample']) and all(POSITION.search(p) for p in paths) and len(offsets) == 1:
                    groups[label]['json:layout-offset'] += 1
                elif config == 'composer' and all(TOOLBAR.search(p) for p in paths):
                    groups[label]['json:composer-toolbar'] += 1
                elif all(shape(p) in noisy_paths[label] for p in paths):
                    groups[label]['json:noise-kind'] += 1
                else:
                    groups[label]['json:unexplained'] += 1
                    out['unexplained'].append({'config': config, 'test': test, 'attachment': name, 'sample': attachment['sample'][:5]})
            else:
                if pngs is None:
                    pngs = reports(config)
                before = Image.open(io.BytesIO(base64.b64decode(pngs[('base', test, name)]))).convert('RGB')
                after = Image.open(io.BytesIO(base64.b64decode(pngs[('del', test, name)]))).convert('RGB')
                box = ImageChops.difference(before, after).getbbox() if before.size == after.size else None
                groups[label]['png:stable'] += 1
                stable_pngs.append({'test': test, 'attachment': name, 'sizes': [before.size, after.size], 'box': box,
                                    'pixels': attachment.get('pixels'), 'maxChannelDiff': attachment.get('maxChannelDiff')})
    out['configs'][config] = {'totals': pair['totals'], 'noiseTotals': noise['totals'],
                              'groups': {label: dict(counts) for label, counts in sorted(groups.items())}, 'stablePngs': stable_pngs}
print(json.dumps(out, indent=1, ensure_ascii=False, default=list))
sys.exit(1 if out['unexplained'] else 0)
