#!/usr/bin/env python3
"""crop.py ENV NAME X0 Y0 X1 Y1 [SCALE]: reference over delivery (dev runs), cropped and scaled, to cmp-NAME.png."""
import sys
from PIL import Image
env, name, x0, y0, x1, y1 = sys.argv[1], sys.argv[2], *map(int, sys.argv[3:7])
scale = int(sys.argv[7]) if len(sys.argv) > 7 else 1
V = '/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/v1/dev'
a = Image.open(f'{V}/ref-{env}/shots/{env}/{name}.png').crop((x0, y0, x1, y1))
b = Image.open(f'{V}/del-{env}/shots/{env}/{name}.png').crop((x0, y0, x1, y1))
w, h = a.size
out = Image.new('RGB', (w, h * 2 + 4), (255, 0, 0))
out.paste(a, (0, 0)); out.paste(b, (0, h + 4))
if scale > 1: out = out.resize((out.width * scale, out.height * scale), Image.NEAREST)
out.save(f'/mnt/data/tmp/34Za39J4QY3kDa5p2Wsau/cmp-{name}.png')
