#!/usr/bin/env python3
"""Usage: crops.py <out-dir> — for each settings-saved / profile-validation screenshot (8 projects): the
notification region (card rect + 34 px for the shadow, from the fix run's recorded state) cropped from the
P0 expectation and from each diagnosis run, magnified 2x (nearest neighbour), side by side with labels.
Crops only; the full PNGs and their SHA-256 are in the runs' snapshot listings."""
import json, sys, pathlib, math
from PIL import Image, ImageDraw
B = pathlib.Path('/var/tmp/p23b1/runs')
EXP = pathlib.Path('/var/tmp/p23b1/trees/tip/src/web/.ui-migration-results/expected-screenshots')
out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
sources = [('P0 expectation', None), ('e361ee373 (pre-B1)', 'diag-e361ee373'), ('57f792135 (B1)', 'diag-57f792135'),
           ('drift tree + fix v2', 'diag-verify-after-v2'), ('tip + fix v2', 'diag-fix-v2')]
states = json.load(open(B / 'diag-fix/states.json'))
index = []
for key in sorted(states):
    if 'notification-error' in key: continue
    rects = [c['rect'] for c in states[key]['dom']['cards']]
    x0 = max(0, math.floor(min(r['x'] for r in rects)) - 34); y0 = max(0, math.floor(min(r['y'] for r in rects)) - 34)
    x1 = math.ceil(max(r['right'] for r in rects)) + 34; y1 = math.ceil(max(r['bottom'] for r in rects)) + 34
    tiles = []
    for label, run in sources:
        path = EXP / key if run is None else B / run / 'snapshots' / key
        img = Image.open(path).convert('RGBA')
        crop = img.crop((x0, y0, min(x1, img.width), min(y1, img.height)))
        tiles.append((label, crop.resize((crop.width * 2, crop.height * 2), Image.NEAREST)))
    w = sum(t.width for _, t in tiles) + 12 * (len(tiles) - 1); h = max(t.height for _, t in tiles) + 22
    sheet = Image.new('RGBA', (w, h), (255, 255, 255, 255)); draw = ImageDraw.Draw(sheet); x = 0
    for label, t in tiles:
        draw.text((x + 2, 4), label, fill=(0, 0, 0, 255)); sheet.paste(t, (x, 22)); x += t.width + 12
    name = key.replace('/', '--')
    sheet.save(out / name)
    index.append({'screenshot': key, 'box': [x0, y0, x1, y1], 'file': name, 'columns': [l for l, _ in sources]})
json.dump(index, open(out / 'index.json', 'w'), indent=1)
print(len(index), 'sheets')
