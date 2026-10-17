#!/usr/bin/env python3
"""extract-deleted.py BEFORE_REPORT.json OUT.json: what the retirement deletes, item by item.

For every retired AntD-side target: its sequences, and, per sequence, the outcome batch 2's own evidence recorded
for that target (the AntD-side paced reference and burst mismatch count, read out of p2-keyboard-window-2/
combinations.md, which render-tables.py generated from keyboard-window-summary.json), plus the pointer to that
file and to the probe's own baseline run directories. The failing test names come from the before-run's report.
"""
import base64
import json
import re
import sys

ANSI = re.compile(r'\x1b\[[0-9;]*m')
# The two dialog targets fail before any key: the probe's opening step waits for the fixture button the target names.
DIALOG_FIELD = {
    'antd-dialog': "getByRole('button', { name: 'AntD dialog', exact: true }).first()",
    'antd-confirm': "getByRole('button', { name: 'AntD confirm', exact: true }).first()",
}

EVIDENCE = '/root/.orbit/worktrees/9492e7a5-a50c-5c6e-bd00-33a8246c5b34/docs/evidence/base-ui-migration/p2-keyboard-window-2'
RETIRED = ['antd-menu', 'antd-submenu', 'antd-session', 'antd-sample', 'antd-popconfirm', 'antd-dialog', 'antd-confirm']
# Which run directories of batch 2 hold each AntD target's samples.
RUN_DIRS = {
    'antd-menu': ['baseline-menu-a', 'baseline-menu-b', 'baseline-menu-c'],
    'antd-submenu': ['baseline-sub-a', 'baseline-sub-b', 'baseline-sub-c', 'baseline-sub-d'],
    'antd-session': ['baseline-sub-a', 'baseline-sub-b', 'baseline-sub-c', 'baseline-sub-d'],
    'antd-sample': ['baseline-select-a', 'baseline-select-b', 'baseline-select-c'],
    'antd-popconfirm': ['baseline-pop'],
    'antd-dialog': ['baseline-dlg'],
    'antd-confirm': ['baseline-dlg'],
}


def combinations():
    """{section: {sequence: {target: cell}}} from combinations.md."""
    out, section, header = {}, None, []
    for line in open(f'{EVIDENCE}/combinations.md'):
        line = line.rstrip('\n')
        if line.startswith('## '):
            section = line[3:].strip()
            out.setdefault(section, {})
            header = []
        elif line.startswith('| ') and section is not None:
            cells = [c.strip().replace('\\|', '|') for c in re.split(r'(?<!\\)\|', line.strip().strip('|'))]
            if not header:
                header = [c.strip('`') for c in cells]
                continue
            if all(set(c) <= set('-: ') for c in cells):
                continue
            sequence = re.match(r'`([^`]+)`', cells[0]).group(1)
            row = dict(zip(header, cells))
            row['_label'] = cells[0]
            out[section][sequence] = row
    return out


def main(report_path, out_path):
    report = json.load(open(report_path))
    red, per_target_sequences = [], {}
    for suite in report.get('suites', []):
        for spec in suite.get('specs', []):
            for test in spec.get('tests', []):
                if test.get('status') == 'expected':
                    continue
                result = (test.get('results') or [{}])[-1]
                error = [ANSI.sub('', line) for line in ((result.get('error') or {}).get('message') or '').splitlines()]
                red.append({
                    'name': spec['title'],
                    'error': next((line.strip() for line in error if line.strip().startswith('Error:')), ''),
                    'waited_for': next((line.strip().removeprefix('Locator: ') for line in error if line.strip().startswith('Locator: ')),
                                       next((line.strip().removeprefix('waiting for ') for line in error if line.strip().startswith('waiting for ')), ''))
                                  or DIALOG_FIELD.get(spec['title'].split(' ')[0], ''),
                    'pointer': 'p2-keyboard-window-2/keyboard-window-2.browser.mjs opening precondition (line 218 for submenus, the field locator for dialogs)',
                })
                target = spec['title'].split(' ')[0]
                sequence = spec['title'].split(' ')[1]
                per_target_sequences.setdefault(target, set()).add(sequence)
    combos = combinations()
    deleted = {}
    for target in RETIRED:
        items = []
        for section, rows in combos.items():
            for sequence, row in rows.items():
                if target in row and row[target].strip() != '—':
                    items.append({
                        'sequence': sequence,
                        'note': row['_label'][row['_label'].find('（'):] if '（' in row['_label'] else '',
                        'section': section,
                        'antd_recorded': re.sub(r'\*\*|`', '', row[target]).replace('<br>', '； '),
                        'pointer': f'p2-keyboard-window-2/combinations.md §{section} 「{sequence}」的 `{target}` 列',
                    })
        deleted[target] = {
            'url': 'see p2-keyboard-window-2/README.md target table',
            'sequences': items,
            'run_dirs': RUN_DIRS[target],
            'red_sequences_here': sorted(per_target_sequences.get(target, [])),
        }
    out = {'red_failing_tests': sorted(red, key=lambda item: item['name']), 'deleted_targets': deleted}
    json.dump(out, open(out_path, 'w'), ensure_ascii=False, indent=2)
    print(f"red: {len(red)}; targets: {len(deleted)}; sequences per target: "
          f"{ {t: len(v['sequences']) for t, v in deleted.items()} }")


if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
