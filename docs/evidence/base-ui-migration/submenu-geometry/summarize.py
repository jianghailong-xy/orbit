"""summarize.py <geometry.json>: each case's submenu box from its item, the replaced AntD one against Orbit's.

Prints one Markdown row per project, place and case: side, x and y from the item's top left corner, width and
height, for both; whether the boxes are equal (the resident test's comparison); and whether the item was at the
same place in both pages (it is not where the two pages' widths differ, see the README). Then the counts.
"""
import json, sys

geometry = json.load(open(sys.argv[1]))

def shape(record):
    item, sub = record['item'], record['submenu']
    side = 'right' if sub['x'] + sub['width'] / 2 > item['x'] + item['width'] / 2 else 'left'
    return side, round(sub['x'] - item['x'], 3), round(sub['y'] - item['y'], 3), sub['width'], sub['height']

def cell(s):
    return f'{s[0]} x {s[1]:g} y {s[2]:g} w {s[3]:g} h {s[4]:g}'

boxes = places = cases_seen = 0
print('| environment | place | case | item x | AntD | Orbit | same box | same place |')
print('| --- | --- | --- | ---: | --- | --- | --- | --- |')
for project, tests in geometry.items():
    for title, cases in tests.items():
        place = title.split('submenu at the ')[1].split(' settles')[0]
        for name, record in cases.items():
            a, o = shape(record['antd']), shape(record['orbit'])
            box, place_same = a == o, record['antd']['item'] == record['orbit']['item']
            cases_seen += 1
            boxes += box
            places += place_same
            item = record['antd']['item']['x'] if place_same else f"{record['antd']['item']['x']:g} / {record['orbit']['item']['x']:g}"
            print(f'| {project} | {place} | {name} | {item} | {cell(a)} | {cell(o)} | {"yes" if box else "**no**"} | {"yes" if place_same else "no"} |')
print(f'\n{cases_seen} cases: the same box in {boxes}, the item at the same place in {places}')
