#!/usr/bin/env python3
"""pairs.py REF_SHOTS DEL_SHOTS OUT.png ENV/SHOT[@x0,y0,x1,y1] ...: for each screenshot pair, the region
(given, or the bounding box of the >2-level differences, padded) cropped from the reference (left) and
the delivery (right), with a red mask of the differing pixels underneath, stacked into one image.
Only reads the screenshots."""
import sys
import numpy as np
from PIL import Image, ImageDraw

ref_dir, del_dir, out = sys.argv[1:4]
rows = []
for arg in sys.argv[4:]:
    spec, _, box = arg.partition('@')
    env, shot = spec.split('/')
    a = Image.open(f'{ref_dir}/{env}/{shot}').convert('RGB')
    b = Image.open(f'{del_dir}/{env}/{shot}').convert('RGB')
    d = np.abs(np.asarray(a).astype(int) - np.asarray(b).astype(int)).max(axis=2)
    if box:
        x0, y0, x1, y1 = map(int, box.split(','))
    else:
        ys, xs = np.nonzero(d > 2)
        if not len(xs):
            continue
        x0, y0, x1, y1 = max(xs.min() - 24, 0), max(ys.min() - 24, 0), min(xs.max() + 24, a.width), min(ys.max() + 24, a.height)
    scale = 2 if (x1 - x0) < 320 else 1
    ca, cb = a.crop((x0, y0, x1, y1)), b.crop((x0, y0, x1, y1))
    mask = Image.fromarray(((d[y0:y1, x0:x1] > 2) * 255).astype('uint8')).convert('RGB')
    w, h = (x1 - x0) * scale, (y1 - y0) * scale
    # At least as wide as its label.
    tile = Image.new('RGB', (max(w * 3 + 20, 720), h + 18), 'white')
    for i, im in enumerate((ca, cb, mask)):
        tile.paste(im.resize((w, h)), (i * (w + 10), 18))
    ImageDraw.Draw(tile).text((2, 2), f'{env}/{shot} [{x0},{y0},{x1},{y1}] ref | del | diff', fill='black')
    rows.append(tile)
W = max(r.width for r in rows)
H = sum(r.height + 6 for r in rows)
sheet = Image.new('RGB', (W, H), (200, 200, 200))
y = 0
for r in rows:
    sheet.paste(r, (0, y))
    y += r.height + 6
sheet.save(out)
print(out, sheet.size)
