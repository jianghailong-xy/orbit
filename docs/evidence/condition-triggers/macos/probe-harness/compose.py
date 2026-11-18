#!/usr/bin/env python3
# TEMPORARY evidence probe (see README.md): set each Mac picture beside the board frame it answers.
#
#   python3 compose.py <board dir: docs/mocks/condition-triggers> <shots dir> <out dir>
#
# The frames are cut from the board's own renders (01-board-1.png holds ① ② ③, 01-board-2.png ④ ⑤ ⑥); the boxes
# are in those images' pixels.
import os
import sys

from PIL import Image, ImageDraw, ImageFont

BOARD, SHOTS, OUT = sys.argv[1:4]
FRAMES = {
    "2": ("01-board-1.png", (1015, 330, 1895, 1790)),
    "3": ("01-board-1.png", (1955, 330, 2835, 1790)),
    "4": ("01-board-2.png", (70, 0, 955, 1520)),
    "5": ("01-board-2.png", (1015, 0, 1900, 1400)),
    "6": ("01-board-2.png", (1955, 0, 2845, 1600)),
}
PAIRS = [
    ("2", ["mac-2-task-card"], "frame-2-task-create-card"),
    ("3", ["mac-3-schedule-card", "mac-3b-widen-card"], "frame-3-schedule-create-card"),
    ("4", ["mac-4-scheduled"], "frame-4-scheduled-page"),
    ("5", ["mac-5-run"], "frame-5-run-header"),
    ("6", ["mac-6a-waiting-on-you", "mac-6b-inspector", "mac-6c-inspector-history"], "frame-6-waiting-and-inspector"),
]
HEIGHT = 1500
PAD = 40


def font(size):
    for path in ["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", "/System/Library/Fonts/Helvetica.ttc"]:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def scaled(img):
    return img.resize((round(img.width * HEIGHT / img.height), HEIGHT), Image.LANCZOS)


os.makedirs(OUT, exist_ok=True)
label = font(36)
for frame, shots, name in PAIRS:
    source, box = FRAMES[frame]
    parts = [("Board frame " + frame, scaled(Image.open(os.path.join(BOARD, source)).convert("RGB").crop(box)))]
    for shot in shots:
        path = os.path.join(SHOTS, shot + ".png")
        if os.path.exists(path):
            parts.append(("macOS: " + shot, scaled(Image.open(path).convert("RGB"))))
        else:
            print("missing", path)
    width = sum(p.width for _, p in parts) + PAD * (len(parts) + 1)
    sheet = Image.new("RGB", (width, HEIGHT + PAD * 3), "white")
    draw = ImageDraw.Draw(sheet)
    x = PAD
    for title, picture in parts:
        draw.text((x, PAD // 2), title, fill="black", font=label)
        sheet.paste(picture, (x, PAD * 2))
        x += picture.width + PAD
    sheet.save(os.path.join(OUT, name + ".png"), optimize=True)
    print("wrote", name, sheet.size)
