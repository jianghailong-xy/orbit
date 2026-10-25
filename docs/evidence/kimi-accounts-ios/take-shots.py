# Copy the probe's iPhone screenshots into the evidence folder, downscaled from the simulator's 3x to 2x
# and kept to a 256-colour palette, which UI screens survive and the repository's size is spared.
# python3 take-shots.py <results ios dir> <evidence dir>
import os
import sys

from PIL import Image

src, dst = sys.argv[1], sys.argv[2]
for name in sorted(os.listdir(src)):
    if not (name.startswith("ios-") and name.endswith(".png")):
        continue
    image = Image.open(os.path.join(src, name))
    w, h = image.size
    scaled = image.convert("RGB").resize((round(w * 2 / 3), round(h * 2 / 3)), Image.LANCZOS)
    scaled = scaled.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.FLOYDSTEINBERG)
    scaled.save(os.path.join(dst, name), optimize=True)
    print(name, image.size, "->", scaled.size, os.path.getsize(os.path.join(dst, name)))
