"""Copy each capture as a 256-colour PNG: python3 -I quantize.py <in-dir> <out-dir>"""
import os
import sys

from PIL import Image

src, out = sys.argv[1:3]
for name in sorted(os.listdir(src)):
    if not name.endswith('.png') or name.startswith('_'):
        continue
    img = Image.open(os.path.join(src, name)).convert('RGB')
    img.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(os.path.join(out, name), optimize=True)
print(len(os.listdir(out)))
