"""Compact table of choices-first-frame.browser.mjs runs, from the frame records the tests attach.

usage: summarize.py <label>=<raw report.json> [...] > first-frames.json

For every run, project, kind and place (and opening), with boxes as [x, y, width, height]:
- reduced motion (`first-frames`): the first shown frame read in requestAnimationFrame (`firstFrame`) and after it was
  produced (`firstProduced`), the settled box, whether every shown reading equals the settled box (`allAtSettled`),
  whether the owner's scroll stayed put (`ownerStill`), and for places compared with the replaced AntD popup its
  settled box (`antd`) and whether Orbit's box from its anchor is within half a pixel of AntD's (`antdWithinHalfPixel`;
  the submenu compares its top edge only), and where the test did not compare it, why (`antdNotCompared`: a page
  whose visual viewport was narrower than its layout viewport; `antdWithinHalfPixel` is then only informative);
- normal motion (`motion-frames`): the positioner's first and last placed positions and whether all placed frames
  share one (`positionerStill`).
The test's own verdict per result is kept as `status`."""
import base64
import json
import sys

COMPARED = {'submenu': ['y']}


def box(frame):
    return frame and frame.get('shown') and [frame['x'], frame['y'], frame['width'], frame['height']]


def from_anchor(frame, keys):
    return {key: frame[key] - frame['anchor'][key] if key in ('x', 'y') else frame[key] for key in keys}


def reduced(record, kind):
    out = {}
    for place, entry in record.items():
        frames, settled = entry['frames'], entry['settled']
        shown = [frame for frame in frames if frame.get('shown')]
        first_frame = next((frame for frame in shown if frame['when'] == 'frame'), None)
        first_produced = next((frame for frame in shown if frame['when'] == 'produced'), None)
        row = {'firstFrame': box(first_frame), 'firstProduced': box(first_produced), 'settled': box(settled),
               'shownReadings': len(shown), 'allAtSettled': bool(shown) and all(box(frame) == box(settled) for frame in shown),
               'ownerStill': len({frame.get('scrolled') for frame in [*frames, settled] if frame.get('scrolled') is not None}) <= 1}
        antd = entry.get('antd')
        if antd is not None:
            row['antd'] = box(antd)
            keys = COMPARED.get(kind, ['x', 'y', 'width', 'height'])
            if entry.get('antdNotCompared'):
                row['antdNotCompared'] = entry['antdNotCompared']
            if antd.get('shown') and settled.get('shown'):
                mine, theirs = from_anchor(settled, keys), from_anchor(antd, keys)
                row['antdWithinHalfPixel'] = all(abs(mine[key] - theirs[key]) < 0.5 for key in keys)
            else:
                row['antdWithinHalfPixel'] = False
        out[place] = row
    return out


def motion(record):
    out = {}
    for place, frames in record.items():
        placed = [frame for frame in frames if (frame.get('root') or {}).get('opacity', 0) > 0]
        at = [[frame['root']['x'], frame['root']['y']] for frame in placed]
        out[place] = {'placedReadings': len(placed), 'first': at[0] if at else None, 'last': at[-1] if at else None,
                      'positionerStill': bool(at) and all(point == at[-1] for point in at)}
    return out


def walk(suite):
    for spec in suite.get('specs', []):
        for test in spec['tests']:
            yield spec['title'], test
    for child in suite.get('suites', []):
        yield from walk(child)


summary = {}
for argument in sys.argv[1:]:
    label, path = argument.split('=', 1)
    report = json.load(open(path))
    runs = summary.setdefault(label, {})
    for suite in report['suites']:
        for title, test in walk(suite):
            if not suite['file'].endswith('choices-first-frame.browser.mjs') and 'first frame' not in title and 'entrance motion' not in title:
                continue
            kind = title.split(' ', 1)[0]
            for result in test['results']:
                for attachment in result.get('attachments', []):
                    if attachment['name'] not in ('first-frames', 'motion-frames') or 'body' not in attachment:
                        continue
                    record = json.loads(base64.b64decode(attachment['body']))
                    part = 'reduced' if attachment['name'] == 'first-frames' else 'motion'
                    entry = runs.setdefault(test['projectName'], {}).setdefault(kind, {})
                    entry[part] = reduced(record, kind) if part == 'reduced' else motion(record)
                    entry[f'{part}Status'] = result['status']
json.dump(summary, sys.stdout, indent=1)
print()
