"""sweep_gaps.py <png> <frames.txt> <scale> <line-pt> [window-y-offset]: for each row the probe listed, read off the picture how
far the last line's words stop short of the ⋯'s glyph. Each row's last line is the band the row's ⋯ is centred on, and the
ink in that band is split into runs: the ⋯ is the rightmost run, the words end where the run before it ends. Prints one line a
row, then the smallest gap."""
import re
import sys

from PIL import Image

png, frames, scale, line = sys.argv[1], sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
offset = float(sys.argv[5]) if len(sys.argv) > 5 else 0
im = Image.open(png).convert('L')
num = r'(-?[0-9.]+)'
row_re = re.compile(rf'row (\d+): lines (\d+) paragraph \({num}, {num}, {num}, {num}\).*⋯ \({num}, {num}, {num}, {num}\)')
smallest = None
for text in open(frames, encoding='utf-8'):
    m = row_re.search(text)
    if not m:
        continue
    row, lines = int(m.group(1)), int(m.group(2))
    px, py, pw, ph, dx, dy, dw, dh = (float(g) for g in m.groups()[2:])
    bottom = py + ph
    band = (0, int((bottom - line - offset) * scale), im.width, int((bottom - offset) * scale))
    crop = im.crop(band)
    background = max(set(crop.getdata()), key=list(crop.getdata()).count)
    width, height = crop.size
    pixels = crop.load()
    # Columns with ink, from the paragraph's left edge to the ⋯'s frame's right edge.
    left, right = int(px * scale), min(width, int((dx + dw) * scale))
    ink = [x for x in range(left, right) if any(abs(pixels[x, y] - background) > 40 for y in range(height))]
    runs = []
    for x in ink:
        if runs and x - runs[-1][1] <= int(7 * scale):  # the ⋯'s dots lie closer together than this; a gap in it is not a word's end
            runs[-1][1] = x
        else:
            runs.append([x, x])
    if len(runs) < 2:
        print(f'row {row}: lines {lines}: only {len(runs)} run(s) of ink in the last line: words and ⋯ touch, or one is missing: {runs}')
        smallest = 0
        continue
    words_end, dots_start, dots_end = runs[-2][1], runs[-1][0], runs[-1][1]
    gap = (dots_start - words_end) / scale
    print(f'row {row}: lines {lines}: words end at {words_end / scale:.1f}, ⋯ {dots_start / scale:.1f}–{dots_end / scale:.1f} pt, gap {gap:.1f} pt')
    smallest = gap if smallest is None else min(smallest, gap)
print('smallest gap:', smallest)
