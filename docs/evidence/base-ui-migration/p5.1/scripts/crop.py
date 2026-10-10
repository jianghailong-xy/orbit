#!/usr/bin/env python3
"""crop.py REF.png DEL.png X0 Y0 X1 Y1 OUT.png [SCALE]: reference | delivery | >2-level difference, side by side, of one region."""
import sys
from PIL import Image, ImageChops
ref, dele, x0, y0, x1, y1, out = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7]), sys.argv[7]
scale = int(sys.argv[8]) if len(sys.argv) > 8 else 2
a = Image.open(ref).convert('RGB').crop((x0, y0, x1, y1))
b = Image.open(dele).convert('RGB').crop((x0, y0, x1, y1))
d = ImageChops.difference(a, b).convert('L').point(lambda v: 255 if v > 2 else 0).convert('RGB')
w, h = a.size
sheet = Image.new('RGB', (w * 3 + 8, h), (255, 0, 255))
for i, im in enumerate((a, b, d)):
    sheet.paste(im, (i * (w + 4), 0))
sheet = sheet.resize((sheet.width * scale, sheet.height * scale), Image.NEAREST)
sheet.save(out)
