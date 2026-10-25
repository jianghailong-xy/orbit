#!/usr/bin/env python3
"""p0-drift-crops.py RUNS OUT: the standard P0 regression's failures on the delivery (RUNS/f-p0-standard-out) beside the
start's (RUNS/f-p0-standard-start-out), as the base drift the evidence lists: for every failed screenshot, its pixels
and box against the expectation, whether the start's actual screenshot is byte for byte the delivery's, and a crop
of the box (padded) with the expectation on the left and the actual on the right, OUT/<environment>/<shot>.png.
Writes OUT/failures.json and prints a summary. Only reads the runs."""
import json, os, re, sys
import numpy as np
from PIL import Image
runs, out = sys.argv[1:3]
DEL, START = os.path.join(runs, 'f-p0-standard-out'), os.path.join(runs, 'f-p0-standard-start-out')
rows = []
for folder in sorted(os.listdir(DEL)):
    path = os.path.join(DEL, folder)
    if not os.path.isdir(path):
        continue
    for name in sorted(os.listdir(path)):
        if not name.endswith('-actual.png'):
            continue
        shot = name[:-len('-actual.png')]
        env = re.search(r'((?:chromium|webkit)-(?:light|dark)-(?:desktop|phone))$', folder).group(1)
        actual, expected = os.path.join(path, name), os.path.join(path, f'{shot}-expected.png')
        a = np.asarray(Image.open(actual).convert('RGB')).astype(int)
        e = np.asarray(Image.open(expected).convert('RGB')).astype(int)
        start_actual = os.path.join(START, folder, name)
        same_on_start = os.path.exists(start_actual) and open(start_actual, 'rb').read() == open(actual, 'rb').read()
        row = {'environment': env, 'test': folder, 'shot': shot, 'startActualByteIdentical': same_on_start}
        if a.shape != e.shape:
            row['size'] = [list(a.shape), list(e.shape)]
        else:
            diff = np.abs(a - e).max(axis=2) > 0
            ys, xs = np.nonzero(diff)
            box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
            row.update(pixels=int(diff.sum()), box=box)
            pad = 24
            crop = (max(0, box[0] - pad), max(0, box[1] - pad), min(a.shape[1], box[2] + pad + 1), min(a.shape[0], box[3] + pad + 1))
            ea = Image.open(expected).convert('RGB').crop(crop); aa = Image.open(actual).convert('RGB').crop(crop)
            pair = Image.new('RGB', (ea.width * 2 + 12, ea.height), 'white')
            pair.paste(ea, (0, 0)); pair.paste(aa, (ea.width + 12, 0))
            dst = os.path.join(out, env, f'{shot}.png')
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            pair.save(dst, optimize=True)
            row['crop'] = os.path.relpath(dst, out)
        rows.append(row)
os.makedirs(out, exist_ok=True)
json.dump(rows, open(os.path.join(out, 'failures.json'), 'w'), indent=1)
print('failures', len(rows), 'start byte-identical', sum(r['startActualByteIdentical'] for r in rows),
      'boxes', sorted({tuple(r.get('box', [])) for r in rows}))
