#!/usr/bin/env python3
"""Usage: regions.py <out.json> <crops dir> <before dir> <after dir> <project>/<name>.png ...

Where an after original differs from its before original: the differing pixels (count, largest channel
difference), how many differ by more than 2 per channel (the antialiasing level P3.2 and P3.1 used), and
the clusters of those beyond-2 pixels (pixels within 6 px of each other merged; box, pixel count, largest
difference). For each screenshot it writes <crops dir>/<project>--<name>.png: per cluster (at most 4,
largest first) a crop of before | after | difference x4, side by side, stacked. Reads only the PNGs."""
import json, os, sys
import numpy as np
from PIL import Image

out_json, crops, before_dir, after_dir, *shots = sys.argv[1:]
os.makedirs(crops, exist_ok=True)
result = {}
for shot in shots:
    b = np.asarray(Image.open(os.path.join(before_dir, shot)).convert('RGBA')).astype(int)
    a = np.asarray(Image.open(os.path.join(after_dir, shot)).convert('RGBA')).astype(int)
    assert b.shape == a.shape, (shot, b.shape, a.shape)
    delta = np.abs(a - b).max(axis=2)
    ys, xs = np.nonzero(delta > 2)
    # Union-find over the beyond-2 pixels, merging those within 6 px (Chebyshev distance).
    points = list(zip(xs.tolist(), ys.tolist()))
    index = {p: i for i, p in enumerate(points)}
    parent = list(range(len(points)))
    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i
    for i, (x, y) in enumerate(points):
        for dy in range(-6, 7):
            for dx in range(-6, 7):
                j = index.get((x + dx, y + dy))
                if j is not None:
                    ri, rj = find(i), find(j)
                    if ri != rj: parent[ri] = rj
    groups = {}
    for i, (x, y) in enumerate(points):
        groups.setdefault(find(i), []).append((x, y))
    clusters = []
    for members in groups.values():
        gx = [p[0] for p in members]; gy = [p[1] for p in members]
        x0, x1, y0, y1 = min(gx), max(gx), min(gy), max(gy)
        clusters.append({'box': {'x': x0, 'y': y0, 'width': x1 - x0 + 1, 'height': y1 - y0 + 1}, 'pixels': len(members),
                         'maxChannelDelta': int(max(delta[y, x] for x, y in members))})
    clusters.sort(key=lambda c: -c['pixels'])
    dy_all, dx_all = np.nonzero(delta)
    result[shot] = {'differentPixels': int(len(dx_all)), 'maxChannelDelta': int(delta.max()), 'pixelsBeyond2': len(points),
                    'pixelsAtMost2': int(len(dx_all) - len(points)),
                    'allDifferencesBox': {'x': int(dx_all.min()), 'y': int(dy_all.min()), 'width': int(dx_all.max() - dx_all.min() + 1), 'height': int(dy_all.max() - dy_all.min() + 1)} if len(dx_all) else None,
                    'clustersBeyond2': clusters}
    rows = []
    for c in clusters[:4]:
        x0 = max(0, c['box']['x'] - 12); y0 = max(0, c['box']['y'] - 12)
        x1 = min(a.shape[1], c['box']['x'] + c['box']['width'] + 12); y1 = min(a.shape[0], c['box']['y'] + c['box']['height'] + 12)
        cb, ca = b[y0:y1, x0:x1, :3], a[y0:y1, x0:x1, :3]
        cd = np.minimum(255, np.abs(ca - cb) * 4)
        scale = max(1, min(4, 600 // max(x1 - x0, 1)))
        tiles = [Image.fromarray(t.astype(np.uint8)).resize(((x1 - x0) * scale, (y1 - y0) * scale), Image.NEAREST) for t in (cb, ca, cd)]
        row = Image.new('RGB', (tiles[0].width * 3 + 20, tiles[0].height), 'white')
        for k, t in enumerate(tiles): row.paste(t, (k * (tiles[0].width + 10), 0))
        rows.append(row)
    if rows:
        sheet = Image.new('RGB', (max(r.width for r in rows), sum(r.height for r in rows) + 10 * (len(rows) - 1)), 'white')
        top = 0
        for r in rows: sheet.paste(r, (0, top)); top += r.height + 10
        sheet.save(os.path.join(crops, shot.replace('/', '--')))
json.dump(result, open(out_json, 'w'), indent=1)
for shot, r in result.items():
    print(shot.ljust(42), r['differentPixels'], 'px, beyond 2:', r['pixelsBeyond2'], 'max', r['maxChannelDelta'], 'clusters', [(c['box']['x'], c['box']['y'], c['box']['width'], c['box']['height'], c['pixels']) for c in r['clustersBeyond2'][:4]])
