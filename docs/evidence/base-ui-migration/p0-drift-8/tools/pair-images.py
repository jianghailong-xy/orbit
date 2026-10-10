#!/usr/bin/env python3
"""Usage: pair-images.py <out dir> <change> <screenshot> <before run> <after run> [crop=x,y,w,h] ...
(arguments repeat in groups of four, each optionally followed by crop=x,y,w,h)

One representative screenshot from the run on X^1's tree (left) and on X's tree (right), side by side at half
size with a 6px gap; with a crop, the cropped region at 3x instead. Writes index.json with the runs and the
SHA-256 of both originals. Visual aid only; the attribution is the pixel classification in attribution.json.
As p0-drift-2/tools/pair-images.py."""
import hashlib, json, os, sys
from PIL import Image
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
R = '/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG/runs'
args = sys.argv[2:]
groups = []
while args:
    g, args = args[:4], args[4:]
    crop = None
    if args and args[0].startswith('crop='):
        crop = tuple(int(v) for v in args[0][5:].split(',')); args = args[1:]
    groups.append((*g, crop))
index_path = f'{out}/index.json'
index = json.load(open(index_path)) if os.path.exists(index_path) else []
for change, rel, before, after, crop in groups:
    a, b = (Image.open(f'{R}/{run}/snapshots/{rel}').convert('RGB') for run in (before, after))
    if crop:
        x, y, w, h = crop
        a, b = (im.crop((x, y, x + w, y + h)).resize((w * 3, h * 3), Image.NEAREST) for im in (a, b))
    else:
        a, b = (im.resize((im.width // 2, im.height // 2), Image.LANCZOS) for im in (a, b))
    sheet = Image.new('RGB', (a.width + b.width + 6, max(a.height, b.height)), 'white')
    sheet.paste(a, (0, 0)); sheet.paste(b, (a.width + 6, 0))
    name = f"{change}--{rel.replace('/', '--').replace('.png', '')}{'--crop' if crop else ''}.png"
    sheet.save(f'{out}/{name}', optimize=True)
    sha = lambda run: hashlib.sha256(open(f'{R}/{run}/snapshots/{rel}', 'rb').read()).hexdigest()
    index = [i for i in index if i['image'] != name]
    index.append({'image': name, 'change': change, 'screenshot': rel, 'crop': crop, 'left': {'run': before, 'sha256': sha(before)},
                  'right': {'run': after, 'sha256': sha(after)}})
json.dump(sorted(index, key=lambda i: i['image']), open(index_path, 'w'), indent=1)
open(index_path, 'a').write('\n')
print(len(index), 'images')
