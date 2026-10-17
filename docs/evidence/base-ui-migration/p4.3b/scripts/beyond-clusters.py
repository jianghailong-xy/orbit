#!/usr/bin/env python3
"""beyond-clusters.py SUMMARY.json REF_SHOTS DEL_SHOTS: for every beyond-level screenshot, the pixels that
differ by more than 2 levels, grouped into clusters (8px cells, touching cells merge): count, box, max."""
import json, sys
from collections import deque
import numpy as np
from PIL import Image
summary, ref, dele = sys.argv[1:4]
C = 8
for item in json.load(open(summary))['beyond']:
    env, name = item['shot'].split('/')
    a = np.asarray(Image.open(f'{ref}/{env}/{name}').convert('RGBA')).astype(int)
    b = np.asarray(Image.open(f'{dele}/{env}/{name}').convert('RGBA')).astype(int)
    d = np.abs(a - b).max(axis=2)
    mask = d > 2
    h, w = mask.shape
    gh, gw = (h + C - 1) // C, (w + C - 1) // C
    pad = np.zeros((gh * C, gw * C), bool); pad[:h, :w] = mask
    cells = pad.reshape(gh, C, gw, C).any(axis=(1, 3))
    seen = np.zeros_like(cells); boxes = []
    for cy, cx in zip(*np.nonzero(cells)):
        if seen[cy, cx]: continue
        q = deque([(cy, cx)]); seen[cy, cx] = True; members = []
        while q:
            y, x = q.popleft(); members.append((y, x))
            for dy in (-1, 0, 1):
                for dx in (-1, 0, 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < gh and 0 <= nx < gw and cells[ny, nx] and not seen[ny, nx]:
                        seen[ny, nx] = True; q.append((ny, nx))
        ys = [m[0] for m in members]; xs = [m[1] for m in members]
        y0, y1, x0, x1 = min(ys) * C, min(h, (max(ys) + 1) * C) - 1, min(xs) * C, min(w, (max(xs) + 1) * C) - 1
        region = mask[y0:y1 + 1, x0:x1 + 1]
        boxes.append((int(region.sum()), x0, x1, y0, y1, int(d[y0:y1 + 1, x0:x1 + 1][region].max())))
    boxes.sort(reverse=True)
    print(f"{env:22} {name:30} all={int((d>0).sum()):6} gt2={int(mask.sum()):6} max={int(d.max()):3} clusters={len(boxes):3} " +
          ' '.join(f"[{c}px x{x0}-{x1} y{y0}-{y1} m{m}]" for c, x0, x1, y0, y1, m in boxes[:3]))
