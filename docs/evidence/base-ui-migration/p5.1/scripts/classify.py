#!/usr/bin/env python3
"""classify.py COMPARE_DIR: the classes README.md gives the formal round's beyond-level P5.1 screenshots, written out per
screenshot (COMPARE_DIR/p51-beyond-classes.json) from the rules below, with each class's count and largest >2-level pixel
count printed. Each rule names the shots it covers and a ceiling a little above what the last development round measured
for them; a shot outside every rule, or over its ceiling, is `unclassified` and is looked at by hand. collect.sh reads the
file to copy full pairs for every class but edge rasterization, which goes on one cropped sheet. Only reads the comparison.
"""
import collections, json, re, sys

C = sys.argv[1]
summary = json.load(open(f'{C}/p51-summary.json'))
# The >2-level pixel counts, from beyond-clusters.py's listing (the summary's clusters count every differing pixel).
over2 = {}
for line in open(f'{C}/p51-beyond-clusters.txt'):
    m = re.match(r'(\S+)\s+(\S+\.png)\s+all=\s*\d+\s+gt2=\s*(\d+)', line)
    if m:
        over2[f'{m.group(1)}/{m.group(2)}'] = int(m.group(3))

TIPS = ('p51-rail-jobs-tip', 'p51-rail-offline-tip', 'p51-rail-running-tip', 'p51-row-offline-tip', 'p51-merge-conflict-tip',
        'p51-merge-error-tip')
ABOVE = ('p51-usage', 'p51-usage-hover', 'p51-reset-confirm', 'p51-reset-started', 'p51-reset-done', 'p51-reset-unanswered')


def classify(env, shot, gt2, top):
    desktop = env.endswith('-desktop')
    if shot in TIPS and desktop and gt2 <= 16000:
        return 'Tooltip edge padding (accepted in P4.2)'
    if (shot in ABOVE or (shot == 'p51-merge-menu-empty' and env.startswith('webkit-'))) and gt2 <= 5000:
        return 'a popup above its trigger: vertical rounding'
    if shot == 'p51-move-confirm' and top <= 4:
        return 'a dialog shadow over the page: up to 4 levels'
    if gt2 <= 100 and top <= 24:
        return 'edge rasterization'
    return 'unclassified'


out = {}
largest = collections.defaultdict(int)
for item in summary['beyond']:
    env, name = item['shot'].split('/')
    gt2 = over2[item['shot']]
    cls = classify(env, name[:-4], gt2, item['max'])
    out[item['shot']] = {'class': cls, 'pixelsOver2': gt2, 'max': item['max']}
    largest[cls] = max(largest[cls], gt2)
# A case rerun on both trees after it failed in one of them (p51-rerun.sh): its pair, keyed `rerun <env>/<shot>`.
import glob, os
for path in sorted(glob.glob(f'{C}/p51-rerun-*-summary.json')):
    tag = os.path.basename(path)[:-len('-summary.json')]
    counts = {}
    for line in open(f'{C}/{tag}-beyond-clusters.txt'):
        m = re.match(r'(\S+)\s+(\S+\.png)\s+all=\s*\d+\s+gt2=\s*(\d+)', line)
        if m:
            counts[f'{m.group(1)}/{m.group(2)}'] = int(m.group(3))
    for item in json.load(open(path))['beyond']:
        env, name = item['shot'].split('/')
        gt2 = counts[item['shot']]
        cls = classify(env, name[:-4], gt2, item['max'])
        out[f'rerun {item["shot"]}'] = {'class': cls, 'pixelsOver2': gt2, 'max': item['max']}
        largest[cls] = max(largest[cls], gt2)
counts = collections.Counter(v['class'] for v in out.values())
json.dump(out, open(f'{C}/p51-beyond-classes.json', 'w'), indent=1)
for cls in sorted(counts, key=lambda c: -counts[c]):
    shots = sorted(k for k, v in out.items() if v['class'] == cls)
    print(f'{cls}: {counts[cls]}, largest >2-level pixel count {largest[cls]}')
    for shot in shots:
        print(f'    {shot} gt2={out[shot]["pixelsOver2"]} max={out[shot]["max"]}')
