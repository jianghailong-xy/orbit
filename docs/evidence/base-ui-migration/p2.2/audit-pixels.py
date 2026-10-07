"""Report exact differences between retained originals; never edit screenshots."""
from pathlib import Path
from PIL import Image, ImageChops
import json

root = Path(__file__).resolve().parent
destination = root / 'pixel-audit.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
images = {}
for directory in ['full-matrix', 'final-surfaces']:
    for path in sorted((root / directory).glob('*--antd-*.png')):
        images[path.name] = path
rows = []
for path in images.values():
    other = path.with_name(path.name.replace('--antd-', '--orbit-'))
    if not other.exists():
        continue
    old, new = Image.open(path).convert('RGB'), Image.open(other).convert('RGB')
    row = {'old': str(path.relative_to(root)), 'new': str(other.relative_to(root)),
           'oldSize': old.size, 'newSize': new.size}
    if old.size == new.size:
        difference = ImageChops.difference(old, new)
        pixels = list(difference.get_flattened_data())
        row.update(differentPixels=sum(any(pixel) for pixel in pixels),
                   maxChannelDelta=max(channel for pixel in pixels for channel in pixel),
                   boundingBox=difference.getbbox())
    rows.append(row)
summary = {'pairs': len(rows), 'identical': sum(row.get('differentPixels') == 0 for row in rows),
           'differentSize': sum(row['oldSize'] != row['newSize'] for row in rows),
           'sameSizeWithDifferences': sum(row.get('differentPixels', 0) > 0 for row in rows)}
destination.write_text(json.dumps({'summary': summary, 'pairs': rows}, indent=2) + '\n')
print(json.dumps(summary))
