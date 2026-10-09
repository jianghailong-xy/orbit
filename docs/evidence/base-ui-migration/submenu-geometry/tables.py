"""tables.py <before geometry.json> <after geometry.json>: the README's comparison tables.

For each viewport (desktop, phone), place and label: the replaced AntD submenu, the Orbit submenu before the fix
and after it, as side (右/左, or 下 when it sits below its item), x from the item's left edge, width and height;
y from the item's top is printed when it is not 0. A row stands for every project of that viewport and both
samples; where they differ, the cell lists each value found, separated by 或.
"""
import json, sys
from collections import defaultdict

before, after = (json.load(open(path)) for path in sys.argv[1:3])

def shape(record):
    item, sub = record['item'], record['submenu']
    y = round(sub['y'] - item['y'], 3)
    side = '下' if y >= item['height'] else '右' if sub['x'] + sub['width'] / 2 > item['x'] + item['width'] / 2 else '左'
    return f"{side} {round(sub['x'] - item['x'], 3):g} / {sub['width']:g} × {sub['height']:g}" + (f' (y {y:g})' if y else '')

rows = defaultdict(set)
for name, geometry in (('before', before), ('after', after)):
    for project, tests in geometry.items():
        viewport = 'phone' if project.endswith('phone') else 'desktop'
        for title, cases in tests.items():
            place = title.split('submenu at the ')[1].split(' settles')[0]
            for case, record in cases.items():
                label = case.split(', ')[1].split(' label')[0]
                rows[(viewport, place, label, 'antd')].add(shape(record['antd']))
                rows[(viewport, place, label, name)].add(shape(record['orbit']))
labels = {'short': '`Claude`', 'medium': '`Claude · work account`', 'long': '`Claude Opus 5.5 …`'}
names = {'left of the page': '页面左侧', 'middle of the page': '页面中间', 'right edge': '页面右缘', 'right edge of a dialog': '对话框右缘'}
for viewport in ('desktop', 'phone'):
    print(f"\n{'桌面（1280×900；WebKit 1272）' if viewport == 'desktop' else '手机（390×844；WebKit 视觉视口 382）'}\n")
    print('| 位置 | 第二项 | 旧 AntD | 修复前 Orbit | 修复后 Orbit |')
    print('| --- | --- | --- | --- | --- |')
    places = [p for p in dict.fromkeys(k[1] for k in rows if k[0] == viewport)]
    for place in places:
        for label in ('short', 'medium', 'long'):
            cells = [' 或 '.join(sorted(rows[(viewport, place, label, who)])) or '—' for who in ('antd', 'before', 'after')]
            print(f'| {names.get(place, place)} | {labels[label]} | ' + ' | '.join(cells) + ' |')
