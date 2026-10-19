#!/usr/bin/env python3
"""Usage: classify.py <before dir> <after dir> <compare.json> <out.json>

For every pair compare.cjs found different: Chromium pairs within p0-drift README's noise rule (at most 200
pixels, no channel more than 4 apart) are noise; every other pair has each differing pixel classified as
in p0-shots.py (the document scrollbar: the right 8px column or the corner pixel; equal to the before image
shifted right by 4 or 8px; other) and keeps the box of the 'other' pixels."""
import json, sys
from pathlib import Path
from PIL import Image
before, after = Path(sys.argv[1]), Path(sys.argv[2])
rows = json.load(open(sys.argv[3]))['rows']
out = []
for r in rows:
    if r.get('missing') or r.get('bytesEqual'): continue
    f = r['file']
    row = {'file': f, 'differentPixels': r.get('differentPixels'), 'maxChannelDelta': r.get('maxChannelDelta'), 'p0Comparator': r['p0Comparator']}
    if f.startswith('chromium') and r.get('differentPixels', 1e9) <= 200 and r.get('maxChannelDelta', 255) <= 4:
        row['class'] = 'chromium noise'
        out.append(row); continue
    a = Image.open(before / f).convert('RGBA'); b = Image.open(after / f).convert('RGBA')
    if a.size != b.size:
        row['class'] = f'size {a.size} -> {b.size}'
        out.append(row); continue
    A, B = a.load(), b.load(); w, h = a.size
    c = {'scrollbar': 0, 'shift4': 0, 'shift8': 0, 'other': 0}; box = None
    for y in range(h):
        for x in range(w):
            if A[x, y] == B[x, y]: continue
            if x >= w - 8 or (x, y) == (0, 0): c['scrollbar'] += 1
            elif x >= 4 and B[x, y] == A[x - 4, y]: c['shift4'] += 1
            elif x >= 8 and B[x, y] == A[x - 8, y]: c['shift8'] += 1
            else:
                c['other'] += 1
                box = [min(box[0], x), min(box[1], y), max(box[2], x), max(box[3], y)] if box else [x, y, x, y]
    row['class'] = c; row['otherBox'] = box
    out.append(row)
json.dump(out, open(sys.argv[4], 'w'), indent=1)
open(sys.argv[4], 'a').write('\n')
for row in out: print(row['file'].ljust(52), str(row['differentPixels']).rjust(7), row['class'], row.get('otherBox'), row['p0Comparator'][:30])
