"""Compare retained browser originals without editing them or accepting a threshold."""
from pathlib import Path
from PIL import Image, ImageChops
import json
import sys

root = Path(__file__).resolve().parent
final = '--final' in sys.argv
destination = root / ('pixel-audit-final.json' if final else 'pixel-audit.json')
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
rows = []
images = {}
for directory in ['full-matrix', 'network-repeat', 'final-motion'] + (['open-value-final'] if final else []):
    for path in sorted((root / directory).glob('*--antd-*.png')):
        if '--repeat-' not in path.name:
            images[path.name] = path
for path in images.values():
    other = path.with_name(path.name.replace('--antd-', '--orbit-'))
    if not other.exists():
        continue
    old, new = [Image.open(p).convert('RGB') for p in [path, other]]
    row = {'kind': 'motion' if '-midpoint.png' in path.name else 'static',
           'old': str(path.relative_to(root)), 'new': str(other.relative_to(root)),
           'oldSize': old.size, 'newSize': new.size}
    if old.size == new.size:
        difference = ImageChops.difference(old, new)
        pixels = list(difference.get_flattened_data())
        row.update(differentPixels=sum(any(pixel) for pixel in pixels),
                   maxChannelDelta=max(channel for pixel in pixels for channel in pixel),
                   boundingBox=difference.getbbox())
        if row['kind'] == 'motion':
            measurements = json.loads(path.with_name(path.name.split('--antd-')[0] + '--motion.json').read_text())
            phase = 'enter' if '--antd-enter-' in path.name else 'exit'
            box = measurements['orbit'][phase][0]['samples'][0]['box']
            inside = [pixel for index, pixel in enumerate(pixels) if any(pixel)
                      and box['x'] <= index % old.width + .5 <= box['right']
                      and box['y'] <= index // old.width + .5 <= box['bottom']]
            row['differentPixelsInsideSurface'] = len(inside)
            row['maxChannelDeltaInsideSurface'] = max((max(pixel) for pixel in inside), default=0)
            row['surfaceBox'] = box
        if '-phone--attachment-matches-' in path.name:
            appearance = json.loads(path.with_name(path.name.split('--antd-')[0] + '--appearance.json').read_text())
            starts = appearance['orbit']['labelStarts']
            options = appearance['orbit']['popup']['rows']
            outside = 0
            outside_delta = 0
            for index, pixel in enumerate(pixels):
                if not any(pixel):
                    continue
                x, y = index % old.width, index // old.width
                if not any(x >= start and item['y'] <= y + 0.5 <= item['y'] + item['height']
                           for start, item in zip(starts, options)):
                    outside += 1
                    outside_delta = max(outside_delta, *pixel)
            row['differentPixelsOutsideLabelRows'] = outside
            row['maxChannelDeltaOutsideLabelRows'] = outside_delta
    rows.append(row)

def summarize(group):
    return {'pairs': len(group), 'identical': sum(row.get('differentPixels') == 0 for row in group),
            'differentSize': sum(row['oldSize'] != row['newSize'] for row in group),
            'sameSizeWithDifferences': sum(row.get('differentPixels', 0) > 0 for row in group)}

summary = {kind: summarize([row for row in rows if row['kind'] == kind]) for kind in ['static', 'motion']}
destination.write_text(json.dumps({'summary': summary, 'pairs': rows}, indent=2) + '\n')
print(json.dumps(summary))
