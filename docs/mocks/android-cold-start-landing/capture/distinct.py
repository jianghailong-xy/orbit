# distinct.py <out.png> <prefix>: keeps the strip frames that differ from the one before and lays them out with their times.
import sys, glob, re
from PIL import Image, ImageChops, ImageDraw, ImageFont, ImageStat
out, prefix = sys.argv[1], sys.argv[2]
files = sorted(glob.glob(prefix + "-*ms.png"), key=lambda f: int(re.search(r"-(\d+)ms\.png$", f).group(1)))
kept, last = [], None
for f in files:
    im = Image.open(f).convert("RGB")
    # The spinner moves all the time: compare everything but a coarse blur, so only real page changes count.
    small = im.resize((54, 120))
    if last is None or sum(ImageStat.Stat(ImageChops.difference(small, last)).mean) > 4:
        kept.append((int(re.search(r"-(\d+)ms\.png$", f).group(1)), im))
    last = small
print(len(files), "frames;", len(kept), "distinct at", [k[0] for k in kept])
kept = kept[:12]
font = ImageFont.truetype("DejaVuSans.ttf", 17)
w, h = 200, 444
sheet = Image.new("RGB", (len(kept) * (w + 8) + 8, h + 34), (60, 60, 66))
d = ImageDraw.Draw(sheet)
for i, (at, im) in enumerate(kept):
    sheet.paste(im.resize((w, h)), (8 + i * (w + 8), 30))
    d.text((8 + i * (w + 8), 6), f"{at} ms", fill=(255, 255, 255), font=font)
sheet.save(out); print(out, sheet.size)
