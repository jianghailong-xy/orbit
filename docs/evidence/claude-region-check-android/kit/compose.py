"""compose.py <board> <shots-dir> <out-dir>: board 03's two iPhone screens beside the Android app's real ones.

Board 03 (docs/mocks/claude-region-check/03-ios-terminal.png, 3200x2592) draws the session page at (124, 404)-(909, 2107) and HPC's
page at (1006, 404)-(1791, 2107), inside the bezels — the boxes the iOS task's kit cut. Each pair is the board's screen scaled to the
real shot's height, then the real shot, on a white ground: <name>.compare.png. The card close-up is cut from 1-card.png along the band
the device journey recorded (card-band.txt: the card's top and bottom in the screenshot's pixels).
"""
import os
import sys

from PIL import Image

SCREENS = {"session": (124, 404, 909, 2107), "machine": (1006, 404, 1791, 2107)}
PAIRS = [("session", "1-card"), ("machine", "7-machine-page"), ("machine", "7b-machine-engines-note")]
GAP = 48


def card_close(shots, out):
    band = os.path.join(shots, "card-band.txt")
    path = os.path.join(shots, "1-card.png")
    if not (os.path.exists(band) and os.path.exists(path)):
        print("no card band")
        return
    left, top, right, bottom = (round(float(v)) for v in open(band).read().split())
    shot = Image.open(path).convert("RGB")
    pad = round(shot.width * 0.03)
    box = (max(0, left - pad), max(0, top - pad), min(shot.width, right + pad), min(shot.height, bottom + pad))
    target = os.path.join(out, "1b-card-close.png")
    shot.crop(box).save(target, optimize=True)
    print(target, box)


def main(board_path, shots, out):
    os.makedirs(out, exist_ok=True)
    card_close(shots, out)
    board = Image.open(board_path).convert("RGB")
    for screen, name in PAIRS:
        path = os.path.join(shots, name + ".png")
        if not os.path.exists(path):
            print("missing", path)
            continue
        real = Image.open(path).convert("RGB")
        crop = board.crop(SCREENS[screen])
        scaled = crop.resize((round(crop.width * real.height / crop.height), real.height), Image.Resampling.BOX)
        canvas = Image.new("RGB", (scaled.width + GAP + real.width, real.height), "white")
        canvas.paste(scaled, (0, 0))
        canvas.paste(real, (scaled.width + GAP, 0))
        target = os.path.join(out, name + ".compare.png")
        canvas.save(target, optimize=True)
        print(target, canvas.size)


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2], sys.argv[3])
