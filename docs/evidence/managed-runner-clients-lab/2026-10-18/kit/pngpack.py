#!/usr/bin/env python3
"""Recompress the probe's pictures losslessly, in place (PIL's optimizing PNG writer). A file is replaced only when the
new one is smaller and its pixels are identical to the original's; prints what it saved.

  python3 -I pngpack.py DIR...
"""
import os
import sys
import tempfile
from pathlib import Path

from PIL import Image, ImageChops

before = after = kept = replaced = 0
for root in map(Path, sys.argv[1:]):
    for path in sorted(root.rglob('*.png')):
        size = path.stat().st_size
        before += size
        with Image.open(path) as image:
            image.load()
            fd, tmp = tempfile.mkstemp(suffix='.png', dir=path.parent)
            os.close(fd)
            image.save(tmp, optimize=True)
        with Image.open(path) as a, Image.open(tmp) as b:
            same = a.size == b.size and ImageChops.difference(a.convert('RGBA'), b.convert('RGBA')).getbbox() is None
        if same and os.path.getsize(tmp) < size:
            os.replace(tmp, path)
            replaced += 1
        else:
            os.unlink(tmp)
            kept += 1
        after += path.stat().st_size
print(f'{replaced} recompressed, {kept} kept as they were: {before / 1e6:.1f} MB -> {after / 1e6:.1f} MB, pixels unchanged')
