#!/usr/bin/env python3
# Set each Android picture beside the board frame it answers and the iPhone's picture of the same frame.
#
#   python3 compose.py <board dir: docs/mocks/condition-triggers> <iOS shots dir> <Android shots dir> <out dir>
#
# The frames are cut from the board's own renders as the iOS evidence cuts them
# (docs/evidence/condition-triggers/ios/probe-harness/compose.py); the Android pictures are ConditionShotsTest's.
import os
import sys

from PIL import Image, ImageDraw, ImageFont

BOARD, IOS, ANDROID, OUT = sys.argv[1:5]
FRAMES = {
    "2": ("01-board-1.png", (1015, 330, 1895, 1790)),
    "3": ("01-board-1.png", (1955, 330, 2835, 1790)),
    "4": ("01-board-2.png", (70, 0, 955, 1520)),
    "5": ("01-board-2.png", (1015, 0, 1900, 1400)),
    "6": ("01-board-2.png", (1955, 0, 2845, 1600)),
}
# (frame, iOS shots, Android shots, sheet)
SHEETS = [
    ("2", ["ios-2-task-card"], ["frame-2-task-create-card"], "frame-2-task-create-card"),
    ("3", ["ios-3-schedule-card", "ios-3b-widen-card"], ["frame-3-schedule-create-card", "frame-3b-widen-card"],
     "frame-3-schedule-create-card"),
    ("4", ["ios-4-scheduled"], ["frame-4-scheduled-page"], "frame-4-scheduled-page"),
    ("5", ["ios-5-run"], ["frame-5-run-header"], "frame-5-run-header"),
    ("6", ["ios-6a-waiting-on-you", "ios-6b-inspector", "ios-6c-inspector-history"],
     ["frame-6a-waiting-on-you", "frame-6b-inspector", "frame-6c-inspector-history"], "frame-6-waiting-and-inspector"),
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
label = font(32)
for frame, ios, android, name in SHEETS:
    source, box = FRAMES[frame]
    parts = [("Board frame " + frame, scaled(Image.open(os.path.join(BOARD, source)).convert("RGB").crop(box)))]
    for platform, folder, shots in (("iOS", IOS, ios), ("Android", ANDROID, android)):
        for shot in shots:
            path = os.path.join(folder, shot + ".png")
            if not os.path.exists(path):
                sys.exit("missing " + path)
            parts.append((platform + ": " + shot, scaled(Image.open(path).convert("RGB"))))
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
