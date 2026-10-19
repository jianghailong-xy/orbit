#!/usr/bin/env bash
# collect.sh: copy what README.md cites from this task's runs (/mnt/data/tmp/34coPBk43ULRuisicUTAy) into this directory:
#  - runs/: every final-round log (terminal colour codes removed) and its Playwright report with the attachment bodies
#    removed (p0-drift-3/tools/report-summary.py); the standard P0 runs' expectation sources;
#  - compare/: analyze.py's tables;
#  - shots/: the new specs' screenshots of both systems (the open lists of the two pointer cases that change, the Close
#    hovered) for every environment on the delivery and the reference; P4.3a's coordinator screenshots that differ
#    between the trees as reference/delivery crops; the rebind dialog's first option in each environment as one sheet
#    (P4.3a's AntD reference, P4.3a's Orbit delivery, this batch's reference and delivery); the page probe's open
#    pickers on both trees in one environment.
# It writes into fresh subdirectories and stops if one is already there (move it aside first), so it never deletes
# anything. Raw runs stay on /mnt/data until judged.
set -eu
V=/mnt/data/tmp/34coPBk43ULRuisicUTAy
R=$V/runs
E=$(cd "$(dirname "$0")/.." && pwd)
SUMMARY="python3 -I $E/../p0-drift-3/tools/report-summary.py"
for d in runs compare shots; do mkdir "$E/$d"; done
for log in "$R"/*.txt; do sed 's/\x1b\[[0-9;]*m//g' "$log" > "$E/runs/$(basename "$log")"; done
# The runs set aside and run again (README: 环境与磁盘): the setup failures of the first final round and the OOM-killed run.
for d in runs-setup-failed runs-killed; do
  mkdir "$E/runs/$d"
  for log in "$V/$d"/*.txt; do sed 's/\x1b\[[0-9;]*m//g' "$log" > "$E/runs/$d/$(basename "$log")"; done
done
for out in "$R"/*-out; do
  [ -f "$out/report.json" ] && $SUMMARY "$out/report.json" "$E/runs/$(basename "$out" -out).report.summary.json" > /dev/null
done
for t in del ref; do
  [ -f "$R/f-p0-$t-out/expected-screenshots/sources.json" ] && cp "$R/f-p0-$t-out/expected-screenshots/sources.json" "$E/runs/f-p0-$t.expected-sources.json"
done
cp "$V"/compare/*.json "$E/compare/"
python3 -I - "$V" "$E" <<'PY'
import base64, json, os, sys
from PIL import Image, ImageDraw
V, E = sys.argv[1:3]
R, shots = f'{V}/runs', f'{E}/shots'

def tests(rep):
    def walk(suite):
        for spec in suite.get('specs', []):
            for test in spec['tests']:
                yield spec['title'], test['projectName'], test['results']
        for child in suite.get('suites', []):
            yield from walk(child)
    for suite in rep['suites']:
        yield from walk(suite)

def save(results, name, path):
    for result in results[::-1]:
        for item in result.get('attachments', []):
            if item['name'] == name and 'body' in item:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                open(path, 'wb').write(base64.b64decode(item['body']))
                return True
    return False

written = 0
for tree in ('ref', 'del'):
    rep = json.load(open(f'{R}/f-first-option-{tree}-out/report.json'))
    for title, project, results in tests(rep):
        if not title.startswith('opened by pointer with no value'):
            continue
        case = 'first-disabled' if 'first option disabled' in title else 'no-value'
        for system in ('antd', 'orbit'):
            written += save(results, f'{system}-open', f'{shots}/first-option/{tree}/{project}/{case}.{system}.png')
    rep = json.load(open(f'{R}/f-close-hover-{tree}-out/report.json'))
    for title, project, results in tests(rep):
        for system in ('AntD', 'Orbit'):
            written += save(results, f'{system}-close-hover', f'{shots}/close-hover/{tree}/{project}.{system.lower()}.png')

# P4.3a's coordinator screenshots that differ between the trees: the differing area, padded, reference left.
compare = json.load(open(f'{V}/compare/p43a-shots.json'))
for key, item in compare['shots'].items():
    if item['class'] in ('byte-identical', 'pixel-identical'):
        continue
    project, shot = key.split('/')
    a = Image.open(f'{R}/f-p43a-coordinator-ref-shots/{key}').convert('RGB')
    b = Image.open(f'{R}/f-p43a-coordinator-del-shots/{key}').convert('RGB')
    x0, y0, x1, y1 = item.get('box') or [0, 0, a.width, a.height]
    x0, y0, x1, y1 = max(x0 - 48, 0), max(y0 - 48, 0), min(x1 + 48, a.width), min(y1 + 48, a.height)
    tile = Image.new('RGB', ((x1 - x0) * 2 + 8, y1 - y0), 'white')
    tile.paste(a.crop((x0, y0, x1, y1)), (0, 0))
    tile.paste(b.crop((x0, y0, x1, y1)), (x1 - x0 + 8, 0))
    os.makedirs(f'{shots}/p43a', exist_ok=True)
    tile.save(f'{shots}/p43a/{project}.{shot[:-4]}.crop-reference-delivery.png')
    written += 1

# The rebind dialog's first option, every environment, one row each: P4.3a's AntD reference, P4.3a's Orbit delivery,
# this batch's reference and delivery, cropped to the region analyze.py compared, at 2x.
rebind = json.load(open(f'{V}/compare/rebind-vs-antd.json'))
p43a = f'{E}/../p4.3a/shots/p43a-beyond'
rows = []
for project, item in sorted(rebind.items()):
    x0, y0, x1, y1 = item['region']
    x0, y0, x1, y1 = max(x0 - 16, 0), max(y0 - 16, 0), x1 + 16, y1 + 16
    sources = [f'{p43a}/{project}/p43a-coordinator-rebind.reference.png', f'{p43a}/{project}/p43a-coordinator-rebind.delivery.png',
               f'{R}/f-p43a-coordinator-ref-shots/{project}/p43a-coordinator-rebind.png', f'{R}/f-p43a-coordinator-del-shots/{project}/p43a-coordinator-rebind.png']
    crops = [Image.open(path).convert('RGB').crop((x0, y0, x1, y1)).resize(((x1 - x0) * 2, (y1 - y0) * 2), Image.NEAREST) for path in sources]
    rows.append((project, crops))
if rows:
    width = sum(crop.width for crop in rows[0][1]) + 8 * 3
    height = sum(crops[0].height + 20 for _, crops in rows)
    sheet = Image.new('RGB', (width, height), 'white')
    draw = ImageDraw.Draw(sheet)
    y = 0
    for project, crops in rows:
        draw.text((2, y + 2), f'{project}: P4.3a AntD reference | P4.3a Orbit delivery | this reference | this delivery', fill='black')
        x = 0
        for crop in crops:
            sheet.paste(crop, (x, y + 20))
            x += crop.width + 8
        y += crops[0].height + 20
    sheet.save(f'{shots}/rebind-first-option.png')
    written += 1

# The page probe's open pickers on both trees, Chromium light desktop.
for tree in ('ref', 'del'):
    rep = json.load(open(f'{R}/f-probe-pages-{tree}-out/report.json'))
    for title, project, results in tests(rep):
        if project != 'chromium-light-desktop':
            continue
        for name in ('rebind', 'choose', 'expires-until', 'suggested-none'):
            written += save(results, f'{name}-open', f'{shots}/pages/{tree}/{name}.png')
print('screenshots written:', written)
PY
du -sh "$E"
