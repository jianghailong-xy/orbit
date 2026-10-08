"""Compare two directories of web screenshots, picture by picture: size, how many pixels differ at all
and by more than 16 levels in any channel, and the box they fall in. Then each pass's checks file."""
import json
import sys
from pathlib import Path

import numpy as np
from PIL import Image

old_dir, new_dir = Path(sys.argv[1]), Path(sys.argv[2])
old = sorted(p.name for p in old_dir.glob('*.png'))
new = sorted(p.name for p in new_dir.glob('*.png'))
print(f'{len(old)} pictures in {old_dir}, {len(new)} in {new_dir}')
for name in sorted(set(old) ^ set(new)):
    print(f'ONLY IN {"old" if name in old else "new"}: {name}')

identical = 0
for name in sorted(set(old) & set(new)):
    a = np.asarray(Image.open(old_dir / name).convert('RGB'), dtype=np.int16)
    b = np.asarray(Image.open(new_dir / name).convert('RGB'), dtype=np.int16)
    if a.shape != b.shape:
        print(f'SIZE {name}: {a.shape[1]}x{a.shape[0]} -> {b.shape[1]}x{b.shape[0]}')
        continue
    delta = np.abs(a - b).max(axis=2)
    any_px, big_px = int((delta > 0).sum()), int((delta > 16).sum())
    if any_px == 0:
        identical += 1
        print(f'same {name}')
        continue
    ys, xs = np.nonzero(delta > 0)
    box = (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max()))
    print(f'DIFF {name}: {any_px} px differ ({big_px} by >16), box {box}, of {a.shape[1]}x{a.shape[0]}')
print(f'{identical} of {len(set(old) & set(new))} pictures pixel-identical')

for theme in ('light', 'dark'):
    for d in (old_dir, new_dir):
        f = d / f'checks-{theme}.json'
        if not f.exists():
            print(f'{f}: missing')
            continue
        checks = json.loads(f.read_text())
        items = checks if isinstance(checks, list) else checks.get('checks', [])
        passed = sum(1 for c in items if c.get('ok', c.get('pass')))
        print(f'{f}: {passed}/{len(items)} passed')
