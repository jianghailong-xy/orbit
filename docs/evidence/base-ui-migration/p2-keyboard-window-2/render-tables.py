"""Markdown tables for the README from summarize.py's JSON (keyboard-window-summary.json).

usage: render-tables.py <summary.json> <dataset> <group> [--after <dataset>]

<group> is a sequence prefix (menu, sub, select, pop, dlg). Each cell gives the target's paced reference and how many
of its paced samples had it, the burst samples whose result differs from it (with those results), window hits and
hand-offs. With --after, Orbit cells show the burst count before → after and the after reference and hand-offs."""
import json
import re
import sys

TARGETS = {
    'menu': ['antd-menu', 'orbit-menu', 'orbit-menu-sample'],
    'sub': ['antd-session', 'orbit-session', 'antd-submenu', 'orbit-submenu-sample', 'orbit-submenu'],
    'select': ['antd-sample', 'orbit-field', 'orbit-sample'],
    'pop': ['antd-popconfirm', 'orbit-popconfirm'],
    'dlg': ['antd-dialog', 'orbit-dialog', 'antd-confirm', 'orbit-confirm'],
}
VERDICTS = {
    'control': '对照',
    'fix: old AntD correct, Orbit not': '旧 AntD 正确、Orbit 不正确：修',
    'both correct': '旧 AntD 处理；Orbit 已与自己的 paced 一致',
    'old AntD does not handle it; Orbit already keeps its paced result': '旧 AntD 不处理；Orbit 已与自己的 paced 一致',
    'old AntD does not handle it: record, no change': '旧 AntD 不处理：记录',
    'no old sample': '无旧样本',
}


def show(result):
    """A result in a table cell: the dialog container as focus named once, the separators escaped for GitHub tables."""
    result = re.sub(r'@(dialog|alertdialog):.*$', r'@\1（弹层本身）', result or '').strip()
    return '`' + result.replace('|', '\\|') + '`'


def cell(entry, after=None):
    paced, burst = entry['paced'], entry['burst']
    others = ''.join(f"；paced 另有 {show(result)}×{count}" for result, count in paced['others'].items())
    wrong = '，'.join(f"{show(result)}×{count}" for result, count in burst['results'].items())
    text = (f"{show(paced['reference'])} {paced['count']}/{paced['samples']}{others}<br>"
            f"burst 错 **{burst['differ']}/{burst['samples']}**{f'（{wrong}）' if wrong else ''}，窗口 {burst['window']}，交接 {burst['handoff']}")
    if after:
        a_paced, a_burst = after['paced'], after['burst']
        a_wrong = '，'.join(f"{show(result)}×{count}" for result, count in a_burst['results'].items())
        same = '与修复前相同' if a_paced['reference'] == paced['reference'] else show(a_paced['reference'])
        text += (f"<br>**修复后** paced {same} {a_paced['count']}/{a_paced['samples']}；burst 错 **{a_burst['differ']}/{a_burst['samples']}**"
                 f"{f'（{a_wrong}）' if a_wrong else ''}，交接 {a_burst['handoff']}")
    return text


def main(path, dataset, group, after_name=None):
    summary = json.load(open(path))
    cells, verdicts = summary[dataset]['cells'], summary[dataset]['verdicts']
    after = summary[after_name]['cells'] if after_name else {}
    sequences = sorted({key.split(' / ')[0] for key in cells if key.startswith(f'{group}-')})
    targets = [target for target in TARGETS[group] if any(f'{seq} / {target}' in cells for seq in sequences)]
    print('| 序列 | ' + ' | '.join(f'`{target}`' for target in targets) + ' | 结论 |')
    print('| --- | ' + ' | '.join('---' for _ in targets) + ' | --- |')
    for seq in sequences:
        row = []
        for target in targets:
            key = f'{seq} / {target}'
            row.append(cell(cells[key], after.get(key)) if key in cells else '—')
        found = [f"`{name.split(' / ')[1]}` {VERDICTS.get(entry['verdict'], entry['verdict'])}" for name, entry in sorted(verdicts.items())
                 if name.startswith(f'{seq} / ') and entry['verdict'] != 'control'] or ['对照']
        keys = next((entry for name, entry in verdicts.items() if name.startswith(f'{seq} / ')), {})
        print(f"| `{seq}`（{keys.get('control') and '对照 `' + keys['control'] + '`' or '对照'}） | " + ' | '.join(row) + ' | ' + '<br>'.join(found) + ' |')


if __name__ == '__main__':
    args = sys.argv[1:]
    after_name = None
    if '--after' in args:
        index = args.index('--after')
        after_name = args[index + 1]
        del args[index:index + 2]
    main(*args, after_name)
