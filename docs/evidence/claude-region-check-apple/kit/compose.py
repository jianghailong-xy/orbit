"""compose.py <shots-dir> <out-dir>: board 03's two iPhone screens beside this branch's real ones.

Board 03 (docs/mocks/claude-region-check/03-ios-terminal.png, 3200x2592) draws the session page at
(124, 404)-(909, 2107) and HPC's page at (1006, 404)-(1791, 2107), inside the bezels. Each pair is the board's
screen scaled to the real shot's height, then the real shot, on a white ground: <name>.compare.png.
"""
import os
import sys

from PIL import Image

BOARD = "/root/.orbit/worktrees/56867ee8-0393-5994-a045-e70534e40745/docs/mocks/claude-region-check/03-ios-terminal.png"
SCREENS = {"session": (124, 404, 909, 2107), "machine": (1006, 404, 1791, 2107)}
PAIRS = [("session", "ios-01-card"), ("machine", "ios-07-machine-page"), ("machine", "ios-07b-machine-engines-note")]
GAP = 48


def card_close(shots, out):
    """The card alone, cut from ios-01-card.png: the band between its title and its foot that RegionShotTests
    wrote (card-band.txt, in points), widened by the card's own padding, across the composer band's gutters."""
    band = os.path.join(shots, "card-band.txt")
    path = os.path.join(shots, "ios-01-card.png")
    if not (os.path.exists(band) and os.path.exists(path)):
        print("no card band")
        return
    top, bottom = (float(v) for v in open(band).read().split())
    shot = Image.open(path).convert("RGB")
    scale = shot.width / 402  # iPhone 17 Pro: 402 points wide
    box = (round(12 * scale), round((top - 14) * scale), round((402 - 12) * scale), round((bottom + 14) * scale))
    target = os.path.join(out, "ios-01b-card-close.png")
    shot.crop(box).save(target, optimize=True)
    print(target, box)


def main(shots, out):
    os.makedirs(out, exist_ok=True)
    card_close(shots, out)
    board = Image.open(BOARD).convert("RGB")
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
    main(sys.argv[1], sys.argv[2])
