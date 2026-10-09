#!/usr/bin/env python3
"""classify6.py V: the classes README.md gives round 6's 54 beyond-level P4.3a screenshots, written out per screenshot
(v1/compare6/p43a-beyond-classes.json) from the rules below, with each class's count checked against the README table
and the largest >2-level pixel count per class printed. collect.sh reads the file to copy full pairs for every class
but edge rasterization, which goes on one cropped sheet. Only reads the comparison."""
import collections, json, re, sys

V = sys.argv[1]
summary = json.load(open(f'{V}/compare6/p43a-summary.json'))
# The >2-level pixel counts, from beyond-clusters.py's listing (the summary's clusters count every differing pixel).
over2 = {}
for line in open(f'{V}/compare6/p43a-beyond-clusters.txt'):
    m = re.match(r'(\S+)\s+(\S+\.png)\s+all=\s*\d+\s+gt2=\s*(\d+)', line)
    if m:
        over2[f'{m.group(1)}/{m.group(2)}'] = int(m.group(3))


def classify(env, shot):
    if shot == 'p43a-blocker-review':
        return 'dialog initial focus'
    if shot == 'p43a-coordinator-rebind':
        return 'Select opens with no option highlighted'
    if shot in ('p43a-coordinator-landing', 'p43a-coordinator-replace', 'p43a-status-cancel', 'p43a-status-reopen') and env == 'chromium-light-phone':
        return 'mask compositing rounding'
    if (env, shot) in (('webkit-dark-desktop', 'p43a-run-settings-locked'), ('webkit-dark-desktop', 'p43a-coordinator-landing'),
                       ('chromium-light-phone', 'p43a-shared')):
        return 'task graph drawn or not yet (its asynchronous load)'
    if shot == 'p43a-tasks-keys-space':
        return 'keys: task graph load and toolbar height'
    return 'edge rasterization'


EXPECTED = {'dialog initial focus': 8, 'Select opens with no option highlighted': 8, 'mask compositing rounding': 4,
            'task graph drawn or not yet (its asynchronous load)': 3, 'keys: task graph load and toolbar height': 1,
            'edge rasterization': 30}
out = {}
largest = collections.defaultdict(int)
for item in summary['beyond']:
    env, name = item['shot'].split('/')
    cls = classify(env, name[:-4])
    gt2 = over2[item['shot']]
    out[item['shot']] = {'class': cls, 'pixelsOver2': gt2, 'max': item['max']}
    largest[cls] = max(largest[cls], gt2)
counts = collections.Counter(v['class'] for v in out.values())
json.dump(out, open(f'{V}/compare6/p43a-beyond-classes.json', 'w'), indent=1)
for cls, n in EXPECTED.items():
    print(f'{cls}: {counts[cls]} (README {n}), largest >2-level pixel count {largest[cls]}')
sys.exit(0 if dict(counts) == EXPECTED else 1)
