#!/usr/bin/env python3
"""Independent pixel comparison of two PNGs, splitting antialiasing-level noise from real differences.

AA-level pixel: every channel differs by <= 2 levels. Beyond: any channel differs by > 2.
Usage: pngdiff.py <a.png> <b.png> [more pairs as a.png b.png ...]
Prints one JSON line per pair.
"""
import json, sys
import numpy as np
from PIL import Image

def diff(a_path, b_path):
    a = np.asarray(Image.open(a_path).convert("RGBA"), dtype=np.int16)
    b = np.asarray(Image.open(b_path).convert("RGBA"), dtype=np.int16)
    if a.shape != b.shape:
        return {"a": a_path, "b": b_path, "sameSize": False, "shapeA": list(a.shape), "shapeB": list(b.shape)}
    d = np.abs(a - b)
    per_pixel = d.max(axis=2)
    changed = per_pixel > 0
    beyond = per_pixel > 2
    ys, xs = np.where(beyond)
    box = None
    if beyond.any():
        box = [int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())]
    return {
        "a": a_path, "b": b_path, "sameSize": True,
        "bytesIdentical": not changed.any(),
        "changedPixels": int(changed.sum()),
        "aaOnlyPixels": int(changed.sum() - beyond.sum()),
        "beyondPixels": int(beyond.sum()),
        "maxDelta": int(per_pixel.max()),
        "beyondBox": box,
        "totalPixels": int(per_pixel.size),
    }

for i in range(1, len(sys.argv), 2):
    print(json.dumps(diff(sys.argv[i], sys.argv[i + 1])))
