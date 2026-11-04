# shift.py <reference> <other>: how far down <other>'s list sits from <reference>'s, in pixels and dp (density 420/160), by matching
# a band of the list. Pure PIL: sum of absolute differences at each candidate offset.
import sys
from PIL import Image, ImageChops, ImageStat
ref = Image.open(sys.argv[1]).convert("L"); other = Image.open(sys.argv[2]).convert("L")
band = ref.crop((60, 1200, 700, 1420))
best = None
for dy in range(0, 420):
    cand = other.crop((60, 1200 + dy, 700, 1420 + dy))
    score = ImageStat.Stat(ImageChops.difference(band, cand)).mean[0]
    if best is None or score < best[0]: best = (score, dy)
print(f"{sys.argv[2].split('/')[-1]}: down {best[1]} px = {best[1] / 2.625:.1f} dp (mean difference {best[0]:.2f})")
