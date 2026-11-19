#!/usr/bin/env python3
"""Colours at matching points of two screenshots, to settle "is this the same colour" with numbers instead of eyes.

    sample.py IMAGE x,y [x,y ...]          # pixel colours
    sample.py IMAGE --ink x0,y0,x1,y1 BG   # rows/columns in a box that differ from BG (#rrggbb) by more than 6:
                                           # finds a hairline, an outline or a shadow, or proves there is none

Coordinates are the image's own pixels (an iPhone 17 Pro PNG is 1206x2622, a Pixel 10 Pro display 1280x2856), so the
same element sits at different numbers on each side: find it on each image first.
"""
import sys
from PIL import Image


def hexa(p):
    return "#%02x%02x%02x" % p[:3]


def main(argv):
    im = Image.open(argv[1]).convert("RGB")
    if len(argv) > 2 and argv[2] == "--ink":
        x0, y0, x1, y1 = map(int, argv[3].split(","))
        bg = tuple(int(argv[4].lstrip("#")[i:i + 2], 16) for i in (0, 2, 4))
        rows, cols = set(), set()
        for y in range(y0, y1):
            for x in range(x0, x1):
                if max(abs(a - b) for a, b in zip(im.getpixel((x, y)), bg)) > 6:
                    rows.add(y)
                    cols.add(x)
        if not rows:
            print("no ink in the box")
        else:
            print(f"ink rows {min(rows)}..{max(rows)}, columns {min(cols)}..{max(cols)}")
        return
    for pt in argv[2:]:
        x, y = map(int, pt.split(","))
        print(pt, hexa(im.getpixel((x, y))))


if __name__ == "__main__":
    main(sys.argv)
