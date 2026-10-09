#!/usr/bin/env python3
"""quick-diff.py REF_SHOTS DEL_SHOTS: every screenshot both wrote, as identical / antialias (<=2 per channel) /
beyond, with the beyond ones' differing-pixel count, largest channel difference and bounding box. Only reads."""
import os, sys
import numpy as np
from PIL import Image
ref, dele = sys.argv[1:3]
rows = []
for project in sorted(os.listdir(ref)):
    for name in sorted(os.listdir(os.path.join(ref, project))):
        b = os.path.join(dele, project, name)
        if not os.path.exists(b):
            rows.append((project, name, 'missing', '')); continue
        x = np.asarray(Image.open(os.path.join(ref, project, name)).convert('RGBA')).astype(int)
        y = np.asarray(Image.open(b).convert('RGBA')).astype(int)
        if x.shape != y.shape:
            rows.append((project, name, 'size', f'{x.shape} {y.shape}')); continue
        d = np.abs(x - y).max(axis=2)
        if d.max() == 0: rows.append((project, name, 'identical', '')); continue
        if d.max() <= 2: rows.append((project, name, 'antialias', f'{int((d > 0).sum())}px')); continue
        ys, xs = np.nonzero(d > 2)
        rows.append((project, name, 'beyond', f'{int((d > 2).sum())}px max {int(d.max())} box x{xs.min()}-{xs.max()} y{ys.min()}-{ys.max()}'))
for row in rows: print(*row)
from collections import Counter
print(Counter(r[2] for r in rows))
