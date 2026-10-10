#!/usr/bin/env python3
"""Side-by-side boards for task 34cjZaBa8oeCX1YfgZC5I: each frame of docs/mocks/project-main-branch/02-ios.png beside the
Android emulator screenshots (light, dark) that MainBranchDeviceTest took for it.
Usage: compare.py IOS_BOARD DEVICE_DIR OUT_DIR"""
import sys
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

board, device, out = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
out.mkdir(parents=True, exist_ok=True)
ios = Image.open(board).convert('RGB')
# (name, iOS box on the 3800x12058 board, label, Android shots)
frames = [
    ('01-start-card-main-branch', (1004, 520, 1828, 2260), '1 · Start card: Main branch under Tasks land on, on the coordinator\'s suggestion', ['01-start-card-main-branch']),
    ('03-picker', (1898, 520, 2722, 2260), '3, 4 · The picker: branches in the workspace, the value ticked, the hint under the list', ['03-picker']),
    ('05-typed', (2792, 520, 3616, 2260), '5 · A branch the runner never reported: Use “release/3.0”', ['05-typed']),
    ('06-second-project-last-choice', (110, 2970, 934, 4720), '6 · The next project in the repository opens on the last choice, and says so', ['06-second-project-last-choice']),
    ('07-picker-last-chosen', (1004, 2970, 1828, 4720), '7 · The last choice tagged “last chosen”, the value ticked', ['07-picker-last-chosen']),
    ('edge-e-no-repository', (1910, 2980, 2710, 4620), 'Edges · e: no repository, no row (the sentences say main)', ['edge-e-no-repository']),
    ('08-how-it-runs', (1004, 5280, 1828, 7020), '8, 9 · How it runs: Main branch under the line, written on pick; the options name master', ['08-how-it-runs', '09-how-it-runs-automatic']),
    ('10-locked', (1898, 5280, 2722, 7020), '10 · Locked with the line: 🔒 master, the lock sentence under Main branch', ['10-locked']),
    ('11-integration-row', (2810, 5330, 3600, 6800), 'E→11 · The row under the title: ahead of master, synced with master', ['11-integration-row']),
    ('12-line-menu', (110, 7780, 934, 9520), '12 · Tasks land on\'s menu: Directly into master', ['12-line-menu']),
    ('13-automatic-off', (1004, 7780, 1828, 9520), '13–15 · Automatic off, Merging the branch into master, the merge check before master', ['13-automatic-off', '15-merge-check-open']),
]
H = 1300
font = None
for path in ('/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf', '/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf'):
    if Path(path).exists():
        font = ImageFont.truetype(path, 28); small = ImageFont.truetype(path, 22); break
if font is None:
    font = small = ImageFont.load_default()

def fit(im):
    return im.resize((round(im.width * H / im.height), H), Image.LANCZOS)

for name, box, label, shots in frames:
    columns = [('iOS board 02-ios.png', fit(ios.crop(box)))]
    for shot in shots:
        for theme in ('light', 'dark'):
            p = device / 'main-branch' / theme / f'{shot}.png'
            columns.append((f'Android {theme} · {shot}.png', fit(Image.open(p).convert('RGB'))))
    gap, top = 24, 96
    width = sum(c[1].width for c in columns) + gap * (len(columns) + 1)
    canvas = Image.new('RGB', (width, H + top + gap), 'white')
    draw = ImageDraw.Draw(canvas)
    draw.text((gap, 18), label, fill='black', font=font)
    x = gap
    for caption, im in columns:
        draw.text((x, 60), caption, fill=(90, 90, 90), font=small)
        canvas.paste(im, (x, top))
        x += im.width + gap
    target = out / f'{name}.png'
    canvas.quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(target, optimize=True)
    print(target, canvas.size, target.stat().st_size)
