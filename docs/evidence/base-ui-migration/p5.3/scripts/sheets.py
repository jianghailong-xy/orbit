#!/usr/bin/env python3
"""Side-by-side sheets of a same-commit comparison: reference | delivery | where they differ (P5.2's sheets.py, for P5.3).

usage: sheets.py MODE REF_SHOTS DEL_SHOTS OUT_DIR SHOT [SHOT ...]

MODE `key`: for every environment directory under REF_SHOTS and every SHOT name (without .png) both runs wrote, one PNG,
OUT_DIR/<environment>/<shot>.png: the reference screenshot, the delivery's and a map of the pixels that differ (black:
equal; grey: at most 2 levels in every channel; red: more), each at half size. MODE `crop`: SHOT is ENV/NAME, and the
three panes are cut to where the two differ, 48px around, at full size. Sheets are saved in 256 colours. Only reads the runs.
"""
import os
import sys
from PIL import Image, ImageChops, ImageDraw

mode, ref_root, del_root, out_root, *shots = sys.argv[1:]
pairs = [(env, shot) for env in sorted(os.listdir(ref_root)) for shot in shots] if mode == 'key' else [tuple(s.split('/')) for s in shots]
for env, shot in pairs:
    a_path, b_path = os.path.join(ref_root, env, f'{shot}.png'), os.path.join(del_root, env, f'{shot}.png')
    if not (os.path.exists(a_path) and os.path.exists(b_path)):
        continue
    a, b = Image.open(a_path).convert('RGB'), Image.open(b_path).convert('RGB')
    if a.size != b.size:
        print(f'{env}/{shot}: sizes differ {a.size} {b.size}')
        continue
    diff = ImageChops.difference(a, b).convert('RGB')
    mask = Image.new('RGB', a.size, (0, 0, 0))
    px, mp = diff.load(), mask.load()
    changed = 0
    for y in range(a.size[1]):
        for x in range(a.size[0]):
            level = max(px[x, y])
            if level:
                changed += 1
                mp[x, y] = (110, 110, 110) if level <= 2 else (255, 40, 40)
    if mode == 'crop':
        box = diff.getbbox() or (0, 0, a.size[0], a.size[1])
        box = (max(0, box[0] - 48), max(0, box[1] - 48), min(a.size[0], box[2] + 48), min(a.size[1], box[3] + 48))
        a, b, mask = a.crop(box), b.crop(box), mask.crop(box)
        w, h = a.size
        resample = Image.NEAREST
    else:
        w, h = a.size[0] // 2, a.size[1] // 2
        resample = Image.LANCZOS
    sheet = Image.new('RGB', (max(w * 3 + 16, 600), h + 24), (255, 255, 255))
    for i, (image, label) in enumerate(((a, 'reference (AntD)'), (b, 'delivery (Orbit)'), (mask, f'differs: {changed} px'))):
        sheet.paste(image.resize((w, h), resample if i < 2 else Image.NEAREST), (i * (w + 8), 24))
    ImageDraw.Draw(sheet).text((4, 6), f'{env} · {shot} · reference (AntD) | delivery (Orbit) | differs: {changed} px', fill=(0, 0, 0))
    os.makedirs(os.path.join(out_root, env), exist_ok=True)
    sheet.quantize(256, dither=Image.Dither.NONE).save(os.path.join(out_root, env, f'{shot}.png'), optimize=True)
