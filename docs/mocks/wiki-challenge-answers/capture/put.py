# Copy a capture into the board's shots/, optionally cropped (x,y,w,h in the PNG's own pixels), squeezed to 256 colours.
import sys
from PIL import Image, ImageChops
src, dst = sys.argv[1], sys.argv[2]
im = Image.open(src).convert('RGB')
if len(sys.argv) > 3:
    x, y, w, h = map(int, sys.argv[3].split(','))
    im = im.crop((x, y, x + w, y + h))
q = im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE)
q.save(dst, optimize=True)
err = max(b[1] for b in ImageChops.difference(im, q.convert('RGB')).getextrema())
print(dst.split('/')[-1], im.size, 'err', err)
