#!/bin/bash
# Copy the shots the boards use into docs/mocks/cursor-engine/shots, squeezed to a 256-colour palette.
set -e
SRC=/var/tmp/cursor-engine-mock/shots
DST=/root/.orbit/worktrees/ddf4b24c-ca0b-5638-92ba-833b86017f5c/docs/mocks/cursor-engine/shots
mkdir -p "$DST"
cp "$SRC/marks.js" "$DST/marks.js"
for f in "$SRC"/w*-light.png "$SRC"/w*-dark.png; do cp "$f" "$DST/"; done
python3 -I - "$DST" <<'PY'
import sys, os
from PIL import Image
d = sys.argv[1]
for f in sorted(os.listdir(d)):
    if not f.endswith('.png'): continue
    p = os.path.join(d, f)
    Image.open(p).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).save(p, optimize=True)
PY
ls "$DST" | wc -l; du -sh "$DST"
