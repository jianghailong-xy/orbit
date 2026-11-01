"""compose.py <out-dir>: board 02's six frames beside this branch's real-page captures, cut and scaled the way the
board cut its own (crops.json, found by findcrop.py/findscaled.py), and the region-null captures of the base tree and
this branch compared pixel for pixel."""
import json, sys, pathlib
import numpy as np
from PIL import Image, ImageDraw, ImageFont

OUT = pathlib.Path(sys.argv[1]); OUT.mkdir(parents=True, exist_ok=True)
SHOTS = pathlib.Path('/root/.orbit/worktrees/ea00e920-f8d6-543a-a3ad-d78cee336a8f/docs/mocks/claude-region-check/shots')
BRANCH = pathlib.Path('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/out/branch')
BASE = pathlib.Path('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/out/base')
FONT = ImageFont.truetype('/mnt/data/tmp/34pVMqv27RB2CakEffAzt/shots-kit/fonts/Inter.ttf', 26)

# frame -> (capture scene, how board 02 cut it: 'whole' = the whole capture scaled to the shot's width; else a CSS-px
# crop at the capture's own 2x scale, then scaled to the shot's width)
FRAMES = {
    'web-machine-today': ('mm-null', 'whole'),
    'web-machine-new': ('mm-new', 'whole'),
    'web-session-held': ('s-B', 'whole'),
    'web-session-first': ('s-A', (620, 0, 1280, 520.08)),
    'web-picker-closed': ('hero-new', (660, 330, 1240, 770)),
    'web-provider-menu': ('prov-new', (520, 350, 1100, 710)),
}

def cut(capture: Image.Image, how, width: int) -> Image.Image:
    if how != 'whole':
        x0, y0, x1, y1 = (round(v * 2) for v in how)
        capture = capture.crop((x0, y0, x1, y1))
    h = round(capture.size[1] * width / capture.size[0])
    return capture.resize((width, h), Image.BOX) if capture.size[0] != width else capture

def labelled(im: Image.Image, label: str) -> Image.Image:
    pad = 56
    out = Image.new('RGB', (im.size[0], im.size[1] + pad), 'white')
    ImageDraw.Draw(out).text((8, 14), label, fill=(60, 64, 72), font=FONT)
    out.paste(im.convert('RGB'), (0, pad))
    return out

for frame, (scene, how) in FRAMES.items():
    board = Image.open(SHOTS / f'{frame}.png').convert('RGB')
    real = cut(Image.open(BRANCH / f'{scene}.png').convert('RGB'), how, board.size[0])
    real.save(OUT / f'{frame}.real.png', optimize=True)
    left, right = labelled(board, f'Board 02 · {frame} (prototype)'), labelled(real, f'This branch · {scene} (real page)')
    gap = 40
    pair = Image.new('RGB', (left.size[0] + right.size[0] + gap, max(left.size[1], right.size[1])), (236, 238, 242))
    pair.paste(left, (0, 0)); pair.paste(right, (left.size[0] + gap, 0))
    pair.save(OUT / f'{frame}.compare.png', optimize=True)
    print(frame, 'board', board.size, 'real', real.size)

# A runner that reads no region draws what it draws today: the base tree (no region field anywhere) against this
# branch, scene for scene.
rows = []
for scene, branch_scene in [('mm-today', 'mm-today'), ('mm-today', 'mm-null'), ('mm-today', 'mm-allowed'),
                            ('s-queued-today', 's-queued-today'), ('s-queued-today', 's-queued-null'),
                            ('hero-today', 'hero-today'), ('hero-today', 'hero-null'),
                            ('prov-today', 'prov-today'), ('prov-today', 'prov-null')]:
    a = np.asarray(Image.open(BASE / f'{scene}.png').convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(BRANCH / f'{branch_scene}.png').convert('RGB'), dtype=np.int16)
    if a.shape != b.shape:
        rows.append((scene, branch_scene, f'sizes differ {a.shape} vs {b.shape}', None)); continue
    diff = np.abs(a - b).max(axis=2)
    rows.append((scene, branch_scene, int((diff > 0).sum()), int(diff.max())))
with open(OUT / 'region-null.txt', 'w') as f:
    f.write('base tree scene\tthis branch scene\tdiffering pixels\tlargest channel difference\n')
    for r in rows:
        f.write('\t'.join(str(v) for v in r) + '\n')
print(open(OUT / 'region-null.txt').read())
