# Keep PNGs to a 256-colour palette in place: python3 squeeze.py <png>...
import os
import sys

from PIL import Image

for path in sys.argv[1:]:
    before = os.path.getsize(path)
    image = Image.open(path)
    if image.mode != "P":
        image = image.convert("RGB").quantize(colors=256, method=Image.Quantize.MEDIANCUT,
                                              dither=Image.Dither.FLOYDSTEINBERG)
    image.save(path, optimize=True)
    print(path, before, "->", os.path.getsize(path))
