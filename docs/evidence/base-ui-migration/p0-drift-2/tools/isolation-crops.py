#!/usr/bin/env python3
"""Usage: isolation-crops.py <isolation.json> <p0.2 screenshots dir> <out dir>
For each of the six profile-validation screenshots: the notification box cropped from P0.2, X^1+F, X, X+F
and the project tip (left to right), enlarged 3x without smoothing, with a 4px white gap. Visual aid only;
the proofs are the pixel counts in isolation.json."""
import json, os, sys
from PIL import Image
iso, p02, out = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3]
os.makedirs(out, exist_ok=True)
runs = [('P0.2', None), ('X^1+F', 'full-maint-xfix-e6786d077'), ('X', 'full-maint-d233a6cd0'), ('X+F', 'full-maint-xfix-d233a6cd0'), ('tip', 'full-maint-fffcdb532')]
for rel, p in iso['proof1'].items():
    x, y, w, h = p['notificationBox']
    tiles = []
    for name, run in runs:
        path = f'{p02}/{rel}' if run is None else f'/var/tmp/p0d2/runs/{run}/snapshots/{rel}'
        tiles.append(Image.open(path).convert('RGB').crop((x, y, x + w, y + h)).resize((w * 3, h * 3), Image.NEAREST))
    sheet = Image.new('RGB', (sum(t.width for t in tiles) + 4 * (len(tiles) - 1), h * 3), 'white')
    left = 0
    for t in tiles: sheet.paste(t, (left, 0)); left += t.width + 4
    sheet.save(f"{out}/{rel.replace('/', '--')}", optimize=True)
print('crops written to', out)
