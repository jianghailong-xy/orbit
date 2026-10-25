#!/usr/bin/env python3
"""One image per pair: before | after | amplified diff (x8), stacked horizontally.
Usage: sidebyside.py <before.png> <after.png> <out.png> [label]
"""
import sys
import numpy as np
from PIL import Image, ImageDraw

a_path, b_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
label = sys.argv[4] if len(sys.argv) > 4 else ""

a = Image.open(a_path).convert("RGBA")
b = Image.open(b_path).convert("RGBA")
if a.size != b.size:
    b = b.resize(a.size)
an = np.asarray(a, dtype=np.int16)
bn = np.asarray(b, dtype=np.int16)
d = np.abs(an - bn)
vis = np.clip(d[:, :, :3] * 8, 0, 255).astype(np.uint8)
vis_img = Image.fromarray(vis, "RGB").convert("RGBA")

pad = 8
W = a.size[0] * 3 + pad * 2
H = a.size[1] + 24
canvas = Image.new("RGBA", (W, H), (255, 255, 255, 255))
canvas.paste(a, (0, 24))
canvas.paste(b, (a.size[0] + pad, 24))
canvas.paste(vis_img, (a.size[0] * 2 + pad * 2, 24))
dr = ImageDraw.Draw(canvas)
dr.text((4, 6), "BEFORE (delivery with migration reverted)", fill=(0, 0, 0, 255))
dr.text((a.size[0] + pad + 4, 6), "AFTER (final", fill=(0, 0, 0, 255))
dr.text((a.size[0] * 2 + pad * 2 + 4, 6), "DIFF x8: " + label, fill=(0, 0, 0, 255))
canvas.convert("RGB").save(out)
print(out, canvas.size)
