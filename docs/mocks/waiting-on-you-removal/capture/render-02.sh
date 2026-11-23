#!/bin/bash
# Render board 02 to its six PNGs (2x, 256 colours). Retries: the shared host runs out of memory under load.
set -e
cd "$(dirname "$0")/.."
for try in 1 2 3 4 5; do
  if FONTCONFIG_FILE=/mnt/data/pe-mock/fonts.conf node capture/render-02.mjs "$PWD/02-terminal-approvals.html" /tmp/b02-render; then break; fi
  echo "render try $try failed"; sleep 20; [ $try = 5 ] && exit 1
done
python3 -I - "$PWD" <<'PY'
import sys
from PIL import Image
d = sys.argv[1]
for i in range(1, 7):
    im = Image.open(f'/tmp/b02-render-{i}.png').convert('RGB')
    im.quantize(colors=256, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE).save(f'{d}/02-terminal-approvals-{i}.png', optimize=True)
    print(f'02-terminal-approvals-{i}.png', im.size)
PY
