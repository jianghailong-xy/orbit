"""Read original PNG pairs without editing, masking or resampling them (Pillow 12.3.0)."""
import collections
import json
import pathlib
import sys

from PIL import Image

source = pathlib.Path(sys.argv[1])
destination = pathlib.Path(sys.argv[2])
pairs = []
for ant_path in sorted(source.glob('*--AntD-*.png')):
    orbit_path = ant_path.with_name(ant_path.name.replace('--AntD-', '--Orbit-'))
    project = ant_path.name.split('--')[0]
    sample = ant_path.name.split('--')[-1].removeprefix('AntD-').removesuffix('.png')
    kind = sample.split('-input-')[0].replace('-', ' ')
    appearance = json.loads(next(source.glob(project + '--*--appearance.json')).read_text())[kind]['ant']
    with Image.open(ant_path) as ant_file, Image.open(orbit_path) as orbit_file:
        ant, orbit = ant_file.convert('RGBA'), orbit_file.convert('RGBA')
    assert ant.size == orbit.size, (ant_path.name, ant.size, orbit.size)
    width, height = ant.size
    differences = [(index % width, index // width, old, new)
                   for index, (old, new) in enumerate(zip(ant.get_flattened_data(), orbit.get_flattened_data()))
                   if old != new]
    row_counts = collections.Counter(y for _, y, _, _ in differences)
    bands = []
    for y, count in sorted(row_counts.items()):
        if bands and bands[-1]['lastRow'] == y - 1:
            bands[-1]['lastRow'] = y
            bands[-1]['pixels'] += count
        else:
            bands.append({'firstRow': y, 'lastRow': y, 'pixels': count})
    colors = collections.Counter((old, new) for _, _, old, new in differences)
    pair = {'ant': ant_path.name, 'orbit': orbit_path.name, 'size': ant.size,
            'changedPixels': len(differences), 'rowBands': bands,
            'maxChannelDelta': max((abs(a - b) for _, _, old, new in differences for a, b in zip(old, new)), default=0),
            'commonColorChanges': [{'ant': old, 'orbit': new, 'pixels': count}
                                   for (old, new), count in colors.most_common(8)]}
    if differences:
        xs, ys = [p[0] for p in differences], [p[1] for p in differences]
        pair['bounds'] = [min(xs), min(ys), max(xs) + 1, max(ys) + 1]
    if 'drawer' in kind:
        # Fixed fixture geometry: 16px + 24px + 16px header, 8px + 32px + 8px + 1px footer.
        pair['separatorRows'] = [
            {'y': y, 'changedPixels': sum(ant.getpixel((x, y)) != orbit.getpixel((x, y)) for x in range(width)),
             'antCenter': ant.getpixel((width // 2, y)), 'orbitCenter': orbit.getpixel((width // 2, y))}
            for y in (56, height - 49)]
    # Locate every remaining difference against the recorded geometry; do not
    # mask those pixels or use this classification as a pass/fail tolerance.
    def corner(x, y, left, top, box_width, box_height, radius, outset=0):
        # A raster pixel occupies [x,x+1) x [y,y+1); CSS edges can be fractional.
        return (x + 1 > left - outset and x < left + box_width + outset
                and y + 1 > top - outset and y < top + box_height + outset
                and (x < left + radius or x + 1 > left + box_width - radius)
                and (y < top + radius or y + 1 > top + box_height - radius))
    locations = collections.Counter()
    remaining = []
    for x, y, old, new in differences:
        if corner(x, y, 0, 0, width, height, float(appearance['borderRadius'].removesuffix('px'))):
            locations['surface rounded edge'] += 1
            continue
        for control in appearance['controls']:
            # P1.2 fixed controls: radius6, Close radius4; input focus shadow2.
            is_input = 'borderWidth' in control
            if corner(x, y, control['x'], control['y'], control['width'], control['height'],
                      4 if control['name'] == 'Close' else 6, 2 if is_input else 0):
                locations['input rounded edge/shadow' if is_input else 'button rounded edge'] += 1
                break
        else:
            locations['outside rounded edges'] += 1
            remaining.append({'x': x, 'y': y, 'ant': old, 'orbit': new})
    pair['differenceLocations'] = dict(locations)
    if remaining:
        pair['outsideRoundedEdgePixels'] = remaining
    pairs.append(pair)

report = {'pairs': pairs, 'pairCount': len(pairs),
          'identicalPairs': sum(pair['changedPixels'] == 0 for pair in pairs),
          'changedPixels': sum(pair['changedPixels'] for pair in pairs)}
destination.write_text(json.dumps(report, indent=2) + '\n')
print(json.dumps({key: value for key, value in report.items() if key != 'pairs'}))
for pair in pairs:
    if pair['changedPixels']:
        print(pair['ant'].split('--')[0], pair['ant'].split('--')[-1], pair['changedPixels'], pair.get('bounds'))
