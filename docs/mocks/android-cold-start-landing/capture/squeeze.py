# squeeze.py <png...>: 256 colours in place (MAXCOVERAGE, no dither); prints sizes and the worst colour error.
import sys, os
from PIL import Image, ImageChops
for path in sys.argv[1:]:
    before = os.path.getsize(path); im = Image.open(path).convert("RGB")
    q = im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE)
    worst = max(band[1] for band in ImageChops.difference(im, q.convert("RGB")).getextrema())
    q.save(path, optimize=True); print(os.path.basename(path), im.size, before, "->", os.path.getsize(path), "worst", worst)
