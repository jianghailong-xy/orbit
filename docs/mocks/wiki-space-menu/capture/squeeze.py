# Squeezes the board's PNGs to 256 colours. MAXCOVERAGE keeps a UI board's accent colours, which the
# default MEDIANCUT shifts. usage: python3 -I squeeze.py <png> ...
import sys
from PIL import Image
for path in sys.argv[1:]:
    Image.open(path).convert('RGB').quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(path, optimize=True)
