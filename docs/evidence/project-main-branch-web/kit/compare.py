"""Frame-by-frame: each board frame (design) against the real capture of the same clip. Prints the
size check and the pixel difference, and writes compare/<frame>.png: design | real | where they differ."""
import sys
from PIL import Image, ImageChops, ImageDraw, ImageFont

BOARD = '/var/tmp/upstream-branch-mock/board'
SHOTS = '/mnt/data/wmb/kit/shots'
OUT = '/mnt/data/wmb/kit/compare'
FRAMES = [
    ('②', '01b-start-proposal'), ('③', '01c-menu'), ('④', '01d-typed'), ('⑥', '01k-memory-start'),
    ('⑦', '01l-memory-menu'), ('⑨', '01g-run-proposal'), ('⑩', '01h-run-locked'), ('⑪', '01j-line-proposal'),
]
font = ImageFont.truetype('/var/tmp/upstream-branch-mock/fonts/NotoSansSC.ttf', 30)
rows = []
for mark, name in FRAMES:
    design = Image.open(f'{BOARD}/{name}.png').convert('RGB')
    real = Image.open(f'{SHOTS}/{name}.png').convert('RGB')
    same_size = design.size == real.size
    w, h = max(design.width, real.width), max(design.height, real.height)
    a = Image.new('RGB', (w, h), 'white'); a.paste(design)
    b = Image.new('RGB', (w, h), 'white'); b.paste(real)
    diff = ImageChops.difference(a, b).convert('L')
    changed = diff.point(lambda v: 255 if v > 40 else 0)
    count = sum(1 for v in changed.getdata() if v)
    box = changed.getbbox()
    pct = 100 * count / (w * h)
    # The third panel: the real frame, greyed, with every pixel that differs from the design in red.
    third = Image.blend(b, Image.new('RGB', (w, h), 'white'), 0.6)
    red = Image.new('RGB', (w, h), (230, 30, 30))
    third.paste(red, mask=changed)
    gap, head = 40, 70
    sheet = Image.new('RGB', (3 * w + 4 * gap, h + head + gap), (244, 245, 247))
    d = ImageDraw.Draw(sheet)
    for i, (img, label) in enumerate([(a, f'{mark} design · board/{name}.png'), (b, f'{mark} real page · this branch'),
                                      (third, f'{mark} differs (>40/255): {pct:.3f}% of pixels')]):
        x = gap + i * (w + gap)
        d.text((x, 18), label, fill=(30, 30, 30), font=font)
        sheet.paste(img, (x, head))
    sheet.save(f'{OUT}/{name}.png', optimize=True)
    rows.append((mark, name, design.size, real.size, same_size, count, pct, box))
    print(f'{mark} {name}: design {design.size} real {real.size} same_size={same_size} '
          f'differing_px={count} ({pct:.3f}%) bbox={box}')
