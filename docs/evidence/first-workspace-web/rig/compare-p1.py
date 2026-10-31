# Each proposal frame of boards 01 and 02 beside the same crop of the real page: board | real | diff.
# python3 -I compare-p1.py <shots-dir> <out-dir>. Frames keep the board's crop, except where the real
# element sits elsewhere for a stated reason (see SHIFT).
import json, re, sys
from pathlib import Path
from PIL import Image, ImageChops, ImageDraw

K = Path('/var/tmp/first-ws-mock')
FRAMES = Path(sys.argv[3] if len(sys.argv) > 3 else K / 'repo-docs/first-workspace-in-conversation/frames')
SHOTS, OUT = Path(sys.argv[1]), Path(sys.argv[2])
OUT.mkdir(exist_ok=True)
BOARD = json.load(open(K / 'marks.json'))
REAL = json.load(open(SHOTS / 'marks.json'))

def shift(shot, x, y):
    # A card that moved in the pane is compared where it is: same size, other y.
    for part in ('card', 'folderDone'):
        a = BOARD.get(shot, {}).get('boxes', {}).get(part)
        b = REAL.get(shot, {}).get('boxes', {}).get(part)
        if a and b and x > 0:
            return b['x'] - a['x'], b['y'] - a['y']
    return 0, 0

rows = []
for f in sorted(FRAMES.glob('[pe]-*.png')):
    m = re.fullmatch(r'(.+)-(\d+)-(\d+)-(\d+)x(\d+)', f.stem)
    shot, x, y, w, h = m[1], *map(int, m.groups()[1:])
    dx, dy = shift(shot, x, y)
    real = Image.open(SHOTS / f'{shot}.png').convert('RGB')
    box = ((x + dx) * 2, (y + dy) * 2, min((x + dx + w) * 2, real.width), min((y + dy + h) * 2, real.height))
    crop = real.crop(box)
    board = Image.open(f).convert('RGB')
    board = board.resize(crop.size, Image.Resampling.LANCZOS)
    diff = ImageChops.difference(board, crop).convert('L').point(lambda v: 255 if v > 40 else 0)
    changed = sum(1 for v in diff.getdata() if v) / (diff.width * diff.height)
    sheet = Image.new('RGB', (crop.width * 3 + 40, crop.height + 40), 'white')
    d = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate((('board', board), ('real page', crop), (f'changed {changed:.1%}', diff.convert('RGB')))):
        sheet.paste(im, (i * (crop.width + 20), 40))
        d.text((i * (crop.width + 20) + 4, 12), f'{f.stem} · {label}', fill='black')
    sheet.save(OUT / f'{f.stem}.png', optimize=True)
    rows.append((f.stem, dx, dy, changed))
for r in rows:
    print(f'{r[0]:42} moved {r[1]:+d},{r[2]:+d}  changed {r[3]:.2%}')
