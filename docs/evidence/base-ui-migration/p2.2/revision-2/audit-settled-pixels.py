"""Replace only the premature new label captures in the final pixel comparison."""
from pathlib import Path
from PIL import Image, ImageChops
import json

root = Path(__file__).resolve().parent
destination = root / 'pixel-audit-settled.json'
if destination.exists():
    raise SystemExit('Retained evidence is never overwritten.')
previous = json.loads((root / 'pixel-audit-final.json').read_text())
rows = [row for row in previous['pairs'] if not row['old'].endswith('-open-value.png')]
for path in sorted((root / 'open-value-settled').glob('*--antd-*.png')):
    other = path.with_name(path.name.replace('--antd-', '--orbit-'))
    old, new = [Image.open(file).convert('RGB') for file in [path, other]]
    assert old.size == new.size
    difference = ImageChops.difference(old, new)
    pixels = list(difference.get_flattened_data())
    rows.append({'kind': 'static', 'old': str(path.relative_to(root)), 'new': str(other.relative_to(root)),
        'oldSize': old.size, 'newSize': new.size, 'differentPixels': sum(any(pixel) for pixel in pixels),
        'maxChannelDelta': max(channel for pixel in pixels for channel in pixel), 'boundingBox': difference.getbbox()})
assert len(rows) == len(previous['pairs']) == 304
summary = {}
for kind in ['static', 'motion']:
    group = [row for row in rows if row['kind'] == kind]
    summary[kind] = {'pairs': len(group), 'identical': sum(row['differentPixels'] == 0 for row in group),
        'differentSize': sum(row['oldSize'] != row['newSize'] for row in group),
        'sameSizeWithDifferences': sum(row['differentPixels'] > 0 for row in group)}
destination.write_text(json.dumps({'supersedesOnly': '24 open-value captures in pixel-audit-final.json', 'summary': summary, 'pairs': rows}, indent=2) + '\n')
print(json.dumps(summary))
