#!/usr/bin/env python3
"""Side-by-side sheets of a same-commit comparison: reference | delivery | where they differ.

usage: sheets.py REF_SHOTS DEL_SHOTS OUT_DIR SHOT [SHOT ...]

For every environment directory under REF_SHOTS (chromium-dark-desktop, …) and every SHOT name (without .png) both
runs wrote: one PNG, OUT_DIR/<environment>/<shot>.png, holding the reference screenshot, the delivery's and a map of
the pixels that differ (black: equal; grey: at most 2 levels in every channel; red: more), each at half size. Only
reads the runs.
"""
import os
import sys
from PIL import Image, ImageChops, ImageDraw

ref_root, del_root, out_root, *shots = sys.argv[1:]
for env in sorted(os.listdir(ref_root)):
    for shot in shots:
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
        w, h = a.size[0] // 2, a.size[1] // 2
        sheet = Image.new('RGB', (w * 3 + 16, h + 24), (255, 255, 255))
        for i, (image, label) in enumerate(((a, 'reference (AntD)'), (b, 'delivery (Orbit)'), (mask, f'differs: {changed} px'))):
            sheet.paste(image.resize((w, h), Image.LANCZOS if i < 2 else Image.NEAREST), (i * (w + 8), 24))
            ImageDraw.Draw(sheet).text((i * (w + 8) + 4, 6), f'{env} · {shot} · {label}', fill=(0, 0, 0))
        os.makedirs(os.path.join(out_root, env), exist_ok=True)
        sheet.save(os.path.join(out_root, env, f'{shot}.png'), optimize=True)
