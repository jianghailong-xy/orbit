"""Usage: diff-clusters.py expected.png actual.png out.png [pad]
Prints differing-pixel clusters (bounding boxes) and writes a side-by-side crop (expected | actual | diff x4)."""
import sys
from PIL import Image, ImageChops
exp = Image.open(sys.argv[1]).convert('RGBA'); act = Image.open(sys.argv[2]).convert('RGBA')
pad = int(sys.argv[4]) if len(sys.argv) > 4 else 12
if exp.size != act.size:
    print('SIZE', exp.size, act.size)
w, h = min(exp.size[0], act.size[0]), min(exp.size[1], act.size[1])
e = exp.crop((0, 0, w, h)).load(); a = act.crop((0, 0, w, h)).load()
pts = []
maxd = 0
for y in range(h):
    for x in range(w):
        pe, pa = e[x, y], a[x, y]
        if pe != pa:
            d = max(abs(pe[i] - pa[i]) for i in range(4))
            maxd = max(maxd, d)
            pts.append((x, y, d))
print('diff pixels', len(pts), 'max channel diff', maxd)
# cluster by simple grid merge
boxes = []
for x, y, d in pts:
    for b in boxes:
        if b[0] - 6 <= x <= b[2] + 6 and b[1] - 6 <= y <= b[3] + 6:
            b[0] = min(b[0], x); b[1] = min(b[1], y); b[2] = max(b[2], x); b[3] = max(b[3], y); b[4] += 1; b[5] = max(b[5], d)
            break
    else:
        boxes.append([x, y, x, y, 1, d])
for b in boxes[:30]:
    print('box x=%d..%d y=%d..%d n=%d maxd=%d' % (b[0], b[2], b[1], b[3], b[4], b[5]))
if pts and len(sys.argv) > 3:
    x0 = max(0, min(b[0] for b in boxes) - pad); y0 = max(0, min(b[1] for b in boxes) - pad)
    x1 = min(w, max(b[2] for b in boxes) + pad + 1); y1 = min(h, max(b[3] for b in boxes) + pad + 1)
    if (x1 - x0) * (y1 - y0) > 900 * 700:
        b = boxes[0]; x0 = max(0, b[0] - pad); y0 = max(0, b[1] - pad); x1 = min(w, b[2] + pad + 1); y1 = min(h, b[3] + pad + 1)
    ce = exp.crop((x0, y0, x1, y1)); ca = act.crop((x0, y0, x1, y1))
    diff = ImageChops.difference(ce.convert('RGB'), ca.convert('RGB')).point(lambda v: min(255, v * 4))
    cw, ch = ce.size
    scale = max(1, min(4, 600 // max(cw, 1)))
    out = Image.new('RGB', (cw * 3 * scale + 20, ch * scale), 'white')
    for i, img in enumerate([ce.convert('RGB'), ca.convert('RGB'), diff]):
        out.paste(img.resize((cw * scale, ch * scale), Image.NEAREST), (i * (cw * scale + 10), 0))
    out.save(sys.argv[3]); print('crop', (x0, y0, x1, y1), 'scale', scale)
