#!/usr/bin/env python3
"""classify5.py V: the classes README.md gives round 5's 54 beyond-level P4.3a screenshots, written out per screenshot
(v1/compare5/p43a-beyond-classes.json) from the rules below, with each class's count checked against the README table
and the largest >2-level pixel count per class printed. collect.sh reads the file to copy full pairs for every class
but edge rasterization, which goes on one cropped sheet. Only reads the comparison."""
import collections, json, re, sys

V = sys.argv[1]
summary = json.load(open(f'{V}/compare5/p43a-summary.json'))
# The >2-level pixel counts, from beyond-clusters.py's listing (the summary's clusters count every differing pixel).
over2 = {}
for line in open(f'{V}/compare5/p43a-beyond-clusters.txt'):
    m = re.match(r'(\S+)\s+(\S+\.png)\s+all=\s*\d+\s+gt2=\s*(\d+)', line)
    if m:
        over2[f'{m.group(1)}/{m.group(2)}'] = int(m.group(3))


def classify(env, shot):
    if shot == 'p43a-blocker-review':
        return 'dialog initial focus'
    if shot == 'p43a-coordinator-rebind':
        return 'Select opens with no option highlighted'
    if shot in ('p43a-status-reopen', 'p43a-tasks-assign') and env.startswith('webkit') and env.endswith('desktop'):
        return 'WebKit desktop dialog scroll lock'
    if shot == 'p43a-tasks-stop' and env.startswith('webkit') and env.endswith('phone'):
        return 'WebKit phone 382/390'
    if shot in ('p43a-coordinator-landing', 'p43a-coordinator-replace', 'p43a-status-cancel') and env == 'chromium-light-phone':
        return 'mask compositing rounding'
    if shot == 'p43a-tasks-keys-space':
        return 'run-to-run (dependency graph load, toolbar height)'
    return 'edge rasterization'


EXPECTED = {'dialog initial focus': 8, 'Select opens with no option highlighted': 8, 'WebKit desktop dialog scroll lock': 4,
            'WebKit phone 382/390': 2, 'mask compositing rounding': 3,
            'run-to-run (dependency graph load, toolbar height)': 2, 'edge rasterization': 27}
out = {}
largest = collections.defaultdict(int)
for item in summary['beyond']:
    env, name = item['shot'].split('/')
    cls = classify(env, name[:-4])
    gt2 = over2[item['shot']]
    out[item['shot']] = {'class': cls, 'pixelsOver2': gt2, 'max': item['max']}
    largest[cls] = max(largest[cls], gt2)
counts = collections.Counter(v['class'] for v in out.values())
json.dump(out, open(f'{V}/compare5/p43a-beyond-classes.json', 'w'), indent=1)
for cls, n in EXPECTED.items():
    print(f'{cls}: {counts[cls]} (README {n}), largest >2-level pixel count {largest[cls]}')
sys.exit(0 if dict(counts) == EXPECTED else 1)
