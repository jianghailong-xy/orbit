# sheet.py <out.png> <cols> <cell_w> <file...>: a labelled contact sheet.
import sys, os
from PIL import Image, ImageDraw, ImageFont
out, cols, w = sys.argv[1], int(sys.argv[2]), int(sys.argv[3]); files = sys.argv[4:]
font = ImageFont.truetype("DejaVuSans.ttf", 15)
first = Image.open(files[0]); h = int(first.height * w / first.width)
rows = (len(files) + cols - 1) // cols
sheet = Image.new("RGB", (cols * (w + 8) + 8, rows * (h + 30) + 8), (60, 60, 66))
draw = ImageDraw.Draw(sheet)
for i, f in enumerate(files):
    im = Image.open(f).convert("RGB").resize((w, h))
    x = 8 + (i % cols) * (w + 8); y = 8 + (i // cols) * (h + 30)
    sheet.paste(im, (x, y + 22))
    name = os.path.basename(f).replace(".png", "")
    draw.text((x, y + 2), name[-30:], fill=(255, 255, 255), font=font)
sheet.save(out)
print(out, sheet.size)
