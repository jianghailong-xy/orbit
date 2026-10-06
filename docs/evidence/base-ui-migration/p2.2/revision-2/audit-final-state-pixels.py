"""Audit originals after the last open-state fix, retaining all earlier audits."""
from pathlib import Path
from PIL import Image, ImageChops
import json

root = Path(__file__).resolve().parent
destination = root / 'pixel-audit-final-state.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
previous = json.loads((root / 'pixel-audit-settled.json').read_text())
rows = {Path(row['old']).name: row for row in previous['pairs']}
for path in sorted((root / 'open-state-final').glob('*--antd-*.png')):
    other = path.with_name(path.name.replace('--antd-', '--orbit-'))
    old, new = [Image.open(file).convert('RGB') for file in [path, other]]
    assert old.size == new.size
    difference = ImageChops.difference(old, new)
    pixels = list(difference.get_flattened_data())
    row = {'kind': 'motion' if '-midpoint.png' in path.name else 'static',
        'old': str(path.relative_to(root)), 'new': str(other.relative_to(root)),
        'oldSize': old.size, 'newSize': new.size, 'differentPixels': sum(any(pixel) for pixel in pixels),
        'maxChannelDelta': max(channel for pixel in pixels for channel in pixel), 'boundingBox': difference.getbbox()}
    if row['kind'] == 'motion':
        measurements = json.loads(path.with_name(path.name.split('--antd-')[0] + '--motion.json').read_text())
        phase = 'enter' if '--antd-enter-' in path.name else 'exit'
        box = measurements['orbit'][phase][0]['samples'][0]['box']
        inside = [pixel for index, pixel in enumerate(pixels) if any(pixel)
                  and box['x'] <= index % old.width + .5 <= box['right']
                  and box['y'] <= index // old.width + .5 <= box['bottom']]
        row.update(differentPixelsInsideSurface=len(inside),
            maxChannelDeltaInsideSurface=max((max(pixel) for pixel in inside), default=0), surfaceBox=box)
    assert path.name in rows, path.name
    rows[path.name] = row
assert len(rows) == 304
summary = {}
for kind in ['static', 'motion']:
    group = [row for row in rows.values() if row['kind'] == kind]
    summary[kind] = {'pairs': len(group), 'identical': sum(row['differentPixels'] == 0 for row in group),
        'differentSize': sum(row['oldSize'] != row['newSize'] for row in group),
        'sameSizeWithDifferences': sum(row['differentPixels'] > 0 for row in group)}
destination.write_text(json.dumps({'summary': summary, 'pairs': list(rows.values())}, indent=2) + '\n')
print(json.dumps(summary))
