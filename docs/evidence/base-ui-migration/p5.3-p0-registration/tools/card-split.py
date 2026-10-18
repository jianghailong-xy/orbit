#!/usr/bin/env python3
"""Usage: card-split.py <out.json> <before dir> <after dir> <project>/<name>.png=<x0>,<y0>,<x1>,<y1> ...

For session-attachment-staged: splits the before -> after differing pixels by where they lie relative to the
composer card, whose border box (1px border, 24px corner radius, .composer-box in index.css) is given per screenshot
as found on the screenshots themselves (the columns/rows where the border colour changes). Counts the differing
pixels inside the card (inside the border), on the border ring, and outside it (the box shadow), with the largest
channel difference of each part. Reads only the PNGs."""
import json, sys
import numpy as np
from PIL import Image

out, before_dir, after_dir, *specs = sys.argv[1:]
R = 24
def rounded(h, w, x0, y0, x1, y1, r):
    yy, xx = np.mgrid[0:h, 0:w]
    inside = (xx >= x0) & (xx <= x1) & (yy >= y0) & (yy <= y1)
    # Distance from the corner centres for the four corner squares (pixel centres).
    cx = np.where(xx < x0 + r, x0 + r, np.where(xx > x1 - r, x1 - r, xx))
    cy = np.where(yy < y0 + r, y0 + r, np.where(yy > y1 - r, y1 - r, yy))
    return inside & (((xx - cx) ** 2 + (yy - cy) ** 2) <= r * r)
result = {}
for spec in specs:
    shot, box = spec.split('=')
    x0, y0, x1, y1 = map(int, box.split(','))
    b = np.asarray(Image.open(f'{before_dir}/{shot}').convert('RGBA')).astype(int)
    a = np.asarray(Image.open(f'{after_dir}/{shot}').convert('RGBA')).astype(int)
    delta = np.abs(a - b).max(axis=2)
    outer = rounded(*delta.shape, x0, y0, x1, y1, R)           # the border box
    inner = rounded(*delta.shape, x0 + 2, y0 + 2, x1 - 2, y1 - 2, R - 2)  # inside the border, one antialiasing pixel away from it
    ring = outer & ~inner
    parts = {}
    for name, m in (('insideCard', inner), ('borderRing', ring), ('outsideCard', ~outer)):
        d = delta[m]
        parts[name] = {'pixels': int(m.sum()), 'differentPixels': int((d > 0).sum()), 'maxChannelDelta': int(d.max()) if d.size else 0}
    result[shot] = {'cardBorderBox': {'x0': x0, 'y0': y0, 'x1': x1, 'y1': y1, 'radius': R}, 'differentPixels': int((delta > 0).sum()),
                    'maxChannelDelta': int(delta.max()), **parts}
    print(shot.ljust(52), json.dumps(parts))
json.dump(result, open(out, 'w'), indent=1)
