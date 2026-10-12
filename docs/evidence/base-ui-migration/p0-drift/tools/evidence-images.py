#!/usr/bin/env python3
"""Usage: evidence-images.py <dest-dir> — before/after/diff PNGs for one representative screenshot
per attributed change, taken from the runs on the attributed commit and its predecessor."""
import json, os, sys
from PIL import Image
import numpy as np
B = '/var/tmp/p0drift'
dest = sys.argv[1]
CASES = [
    ('A1', 'chromium-light-desktop/session-idle.png', 'full-293e12a85', 'full-918034e72'),
    ('A2', 'chromium-light-desktop/session-idle.png', 'full-6e5ba7544', 'full2-f5bdd7fd3'),
    ('A3', 'chromium-light-desktop/project-overview.png', 'full2-06400e8ea', 'full2-93d3ec580'),
    ('A4', 'chromium-light-desktop/task-detail.png', 'full2-14e64870f', 'full2-4088d37e6'),
    ('A4', 'chromium-light-desktop/settings.png', 'full2-14e64870f', 'full2-4088d37e6'),
    ('A5', 'chromium-dark-desktop/breakpoint-961-wiki.png', 'm5-5bc8c9d63', 'm5-e64d0c72a'),
    ('B1', 'webkit-light-phone/profile-validation.png', 'e361ee373', '57f792135'),
    ('B1', 'chromium-light-desktop/settings-saved.png', 'e361ee373', '57f792135'),
]
index = []
for change, rel, before, after in CASES:
    a = Image.open(f'{B}/runs/{before}/snapshots/{rel}').convert('RGB')
    b = Image.open(f'{B}/runs/{after}/snapshots/{rel}').convert('RGB')
    A, Bv = np.asarray(a).astype(int), np.asarray(b).astype(int)
    d = np.abs(A - Bv).max(axis=2)
    mask = d > 0
    # Diff: the after image faded, every differing pixel red; deltas of 1-4 are amplified the same way.
    out = (np.asarray(b).astype(float) * 0.3 + 255 * 0.7).astype('uint8')
    out[mask] = [255, 0, 0]
    stem = f"{change}--{rel.replace('/', '--')[:-4]}"
    os.makedirs(dest, exist_ok=True)
    a.save(f'{dest}/{stem}--before-{before}.png')
    b.save(f'{dest}/{stem}--after-{after}.png')
    Image.fromarray(out).save(f'{dest}/{stem}--diff.png')
    ys, xs = np.nonzero(mask)
    index.append({'change': change, 'screenshot': rel, 'before': before, 'after': after, 'differentPixels': int(mask.sum()),
                  'maxChannelDelta': int(d.max()), 'box': [int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1)] if mask.any() else None})
    print(stem, int(mask.sum()))
json.dump(index, open(f'{dest}/index.json', 'w'), indent=1)
