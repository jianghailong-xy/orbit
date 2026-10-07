#!/usr/bin/env python3
"""Usage: highlight.py <dir>... — for every *nested-toast-opposite-theme.png found (recursively): count
pixels in the notification area whose blue channel exceeds red by more than 40 (the selection highlight;
the attention card itself is red/grey), and report them."""
import pathlib, sys
import numpy as np
from PIL import Image
for d in map(pathlib.Path, sys.argv[1:]):
    for p in sorted(d.rglob('*nested-toast-opposite-theme*.png')):
        img = np.asarray(Image.open(p).convert('RGB')).astype(int)
        h, w, _ = img.shape
        box = img[0:220, w - 400:w] if w > 600 else img[40:280, 0:w]
        blue = int(((box[:, :, 2] - box[:, :, 0]) > 40).sum())
        print(f"{blue:6} bluish px  {p.relative_to(d)}")
