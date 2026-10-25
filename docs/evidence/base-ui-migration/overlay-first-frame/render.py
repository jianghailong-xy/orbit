"""Markdown tables for the README from first-frames.json (summarize.py's output).

usage: render.py first-frames.json <reference label> <fixed label>

1. Per tree, kind and project: the places where a shown reading was not the settled box / opening scrolled the owner /
   the positioner moved during the normal entrance (counts; the menu's two openings are counted apart).
2. Per kind: the places that failed the first check on the reference tree in every project, and those in only some.
3. The comparisons with the replaced AntD popup that did not hold, and those not made (narrowed visual viewport): how
   many of those agree anyway, and the ones that do not."""
import json
import sys

summary = json.load(open(sys.argv[1]))
ref_label, fix_label = sys.argv[2:4]
PROJECTS = [f'{b}-{c}-{s}' for b in ('chromium', 'webkit') for c in ('light', 'dark') for s in ('desktop', 'phone')]
KINDS = ['menu', 'submenu', 'select', 'combobox', 'multiselect', 'popover', 'tooltip', 'popconfirm']


def counts(entry):
    reduced, motion = entry.get('reduced', {}), entry.get('motion', {})
    first = sum(not row['allAtSettled'] for row in reduced.values())
    scroll = sum(not row['ownerStill'] for row in reduced.values())
    moved = sum(not row['positionerStill'] for row in motion.values())
    return f'{first}/{scroll}/{moved}' if reduced and motion else 'no record'


def table(label):
    runs = summary[label]
    lines = ['| 种类 | ' + ' | '.join(PROJECTS) + ' |', '| --- |' + ' --- |' * len(PROJECTS)]
    for kind in KINDS:
        lines.append(f'| {kind} | ' + ' | '.join(counts(runs.get(project, {}).get(kind, {})) for project in PROJECTS) + ' |')
    return '\n'.join(lines)


print(f'### {ref_label}（只撤回修复）\n\n每格：第一帧不在稳定框的位置数 / 打开时拥有者滚动的位置数 / 默认动效下 Positioner 移动的位置数\n')
print(table(ref_label))
print(f'\n### {fix_label}\n')
print(table(fix_label))
print('\n### 参照树上第一帧不在稳定框的位置\n')
for kind in KINDS:
    per = [{place for place, row in summary[ref_label].get(project, {}).get(kind, {}).get('reduced', {}).items() if not row['allAtSettled']}
           for project in PROJECTS]
    always = set.intersection(*per) if per else set()
    some = set.union(*per) - always if per else set()
    print(f'- {kind}：每个环境都有 {sorted(always) or "无"}' + (f'；部分环境 {sorted(some)}' if some else ''))
print('\n### 与旧 AntD 对照\n')
for label in (ref_label, fix_label):
    misses, skipped, held = [], [], 0
    for project in PROJECTS:
        for kind in KINDS:
            for place, row in summary[label].get(project, {}).get(kind, {}).get('reduced', {}).items():
                if 'antdNotCompared' in row:
                    skipped.append((f'{project} {kind} {place}（视觉/布局视口 Orbit {row["antdNotCompared"]["orbitViewport"]}，AntD {row["antdNotCompared"]["antdViewport"]}）',
                                    row.get('antdWithinHalfPixel'), f'Orbit {row["settled"]}，AntD {row["antd"]}'))
                elif row.get('antdWithinHalfPixel') is False:
                    misses.append(f'{project} {kind} {place}：Orbit {row["settled"]}，AntD {row["antd"]}')
                elif row.get('antdWithinHalfPixel'):
                    held += 1
    agree = sum(1 for _, within, _ in skipped if within)
    print(f'- {label}：{held} 处在半像素以内；不符 {len(misses)} 处；不比较 {len(skipped)} 处（其中两边的框本来就在半像素以内的 {agree} 处）')
    for line in misses:
        print(f'  - 不符：{line}')
    for place, within, boxes in skipped:
        if not within:
            print(f'  - 不比较且不同：{place}：{boxes}')
