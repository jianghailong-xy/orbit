#!/usr/bin/env python3
"""classify.py COMPARE_DIR: the classes README.md gives the formal round's beyond-level P4.4 screenshots, written out per
screenshot (COMPARE_DIR/p44-beyond-classes.json) from the rules below, with each class's count and largest >2-level pixel
count printed. collect.sh reads the file to copy full pairs for every class but edge rasterization and loading-dot frames,
which go on one cropped sheet. Only reads the comparison."""
import collections, json, re, sys

C = sys.argv[1]
summary = json.load(open(f'{C}/p44-summary.json'))
# The >2-level pixel counts, from beyond-clusters.py's listing (the summary's clusters count every differing pixel).
over2 = {}
for line in open(f'{C}/p44-beyond-clusters.txt'):
    m = re.match(r'(\S+)\s+(\S+\.png)\s+all=\s*\d+\s+gt2=\s*(\d+)', line)
    if m:
        over2[f'{m.group(1)}/{m.group(2)}'] = int(m.group(3))

PHONE_ENTRY = ('p44-entry', 'p44-entry-reject', 'p44-entry-more', 'p44-entry-edit', 'p44-entry-retire')


def classify(env, shot):
    phone = env.endswith('-phone')
    if shot == 'p44-settings-workspaces':
        return 'Select opens with no option highlighted'
    if shot == 'p44-plan-edit-kinds' and over2.get(f'{env}/{shot}.png', 0) > 100:
        return "the replaced list's own scrollbar"
    if phone and shot in PHONE_ENTRY:
        return "the entry drawer's 40px phone buttons"
    if phone and shot == 'p44-doc-mark-footnote':
        return 'the replaced tip stays open under the sheet'
    if not phone and shot == 'p44-doc-footnote-44':
        return 'a card above its number: vertical rounding'
    if shot in ('p44-landing', 'p44-links-loading', 'p44-following-loading'):
        return 'loading dots frame'
    if env.startswith('webkit-') and shot == 'p44-settings-setup' and over2.get(f'{env}/{shot}.png', 0) > 100:
        return 'hover kept under the new backdrop (WebKit, pointer not moved)'
    return 'edge rasterization'


out = {}
largest = collections.defaultdict(int)
for item in summary['beyond']:
    env, name = item['shot'].split('/')
    cls = classify(env, name[:-4])
    gt2 = over2[item['shot']]
    out[item['shot']] = {'class': cls, 'pixelsOver2': gt2, 'max': item['max']}
    largest[cls] = max(largest[cls], gt2)
counts = collections.Counter(v['class'] for v in out.values())
json.dump(out, open(f'{C}/p44-beyond-classes.json', 'w'), indent=1)
for cls in sorted(counts, key=lambda c: -counts[c]):
    shots = sorted(k for k, v in out.items() if v['class'] == cls)
    print(f'{cls}: {counts[cls]}, largest >2-level pixel count {largest[cls]}')
    for shot in shots:
        print(f'    {shot} gt2={out[shot]["pixelsOver2"]} max={out[shot]["max"]}')
