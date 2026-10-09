#!/usr/bin/env python3
"""Usage: p0-shots.py <before snapshots> <after snapshots> <changed.json> <outdir>

For every screenshot in changed.json: the before and after originals (copied byte for byte) and a diff mask
in which every pixel that differs is classified: grey = the document's 8px scrollbar gutter on the right
edge or the corner pixel at (0,0) that WebKit paints with it; blue = equal to the before image shifted 4px
right; green = shifted 8px right; red = none of these (content that a moved box uncovers or covers).
Prints the counts per class, which are written to <outdir>/classes.json as well."""
import json, shutil, sys
from pathlib import Path
from PIL import Image
before, after, changed, out = map(Path, sys.argv[1:5])
counts = {}
for row in json.load(open(changed)):
    name = row['screenshot']
    project, file = name.split('/')
    stem = file[:-4]
    d = out / project
    d.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(before / name, d / f'{stem}-before.png')
    shutil.copyfile(after / name, d / f'{stem}-after.png')
    a = Image.open(before / name).convert('RGBA'); b = Image.open(after / name).convert('RGBA')
    A, B = a.load(), b.load()
    w, h = a.size
    gutter = w - 8
    m = Image.new('RGB', (w, h), (0, 0, 0)); M = m.load()
    c = {'scrollbar': 0, 'shift4': 0, 'shift8': 0, 'other': 0}
    for y in range(h):
        for x in range(w):
            if A[x, y] == B[x, y]: continue
            if x >= gutter or (x, y) == (0, 0): M[x, y] = (128, 128, 128); c['scrollbar'] += 1
            elif x >= 4 and B[x, y] == A[x - 4, y]: M[x, y] = (0, 90, 255); c['shift4'] += 1
            elif x >= 8 and B[x, y] == A[x - 8, y]: M[x, y] = (0, 200, 0); c['shift8'] += 1
            else: M[x, y] = (255, 0, 0); c['other'] += 1
    m.save(d / f'{stem}-diff.png', optimize=True)
    counts[name] = c
    print(name, c)
json.dump(counts, open(out / 'classes.json', 'w'), indent=1)
open(out / 'classes.json', 'a').write('\n')
