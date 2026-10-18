#!/usr/bin/env python3
"""Usage: regions.py <dirA> <dirB> <split-x> <file>...
For each screenshot pair: changed pixels left of x=<split-x> (the desktop sidebar column) and right of it, with the
bounding box and largest channel delta of each part, and the clusters (8-connected after a 6px dilation) right of it."""
import sys
from PIL import Image, ImageChops
a_dir, b_dir, split = sys.argv[1], sys.argv[2], int(sys.argv[3])
for f in sys.argv[4:]:
    a = Image.open(f'{a_dir}/{f}').convert('RGBA'); b = Image.open(f'{b_dir}/{f}').convert('RGBA')
    d = ImageChops.difference(a, b)
    px = d.load(); W, H = d.size
    parts = {'left': [0, 1e9, 1e9, -1, -1, 0], 'right': [0, 1e9, 1e9, -1, -1, 0]}
    right = []
    for y in range(H):
        for x in range(W):
            m = max(px[x, y])
            if m:
                p = parts['left' if x < split else 'right']
                p[0] += 1; p[1] = min(p[1], x); p[2] = min(p[2], y); p[3] = max(p[3], x); p[4] = max(p[4], y); p[5] = max(p[5], m)
                if x >= split: right.append((x, y, m))
    out = []
    for k, p in parts.items():
        out.append(f"{k}: {p[0]} px" + (f" box x{p[1]}-{p[3]} y{p[2]}-{p[4]} max{p[5]}" if p[0] else ''))
    print(f, ' | '.join(out))
    if right and len(right) < 400:
        print('   right pixels:', right[:40])
