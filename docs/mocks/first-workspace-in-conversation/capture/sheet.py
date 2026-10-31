# Contact sheet: python3 -I sheet.py out.png shot1 shot2 ...   (each scaled to 640 wide, 2 per row)
import sys
from PIL import Image, ImageDraw
out, names = sys.argv[1], sys.argv[2:]
ims = [Image.open(f'/var/tmp/first-ws-mock/shots/{n}.png').convert('RGB') for n in names]
W = 640
th = [im.resize((W, int(im.height * W / im.width)), Image.Resampling.BOX) for im in ims]
cols = 2
rows = [th[i:i + cols] for i in range(0, len(th), cols)]
H = sum(max(t.height for t in r) + 24 for r in rows)
sheet = Image.new('RGB', (W * cols + 10, H), 'white')
y = 0
d = ImageDraw.Draw(sheet)
for ri, r in enumerate(rows):
    for ci, t in enumerate(r):
        sheet.paste(t, (ci * (W + 10), y + 20))
        d.text((ci * (W + 10) + 4, y + 4), names[ri * cols + ci], fill='red')
    y += max(t.height for t in r) + 24
sheet.save(out)
print(sheet.size)
