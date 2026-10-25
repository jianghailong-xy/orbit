#!/usr/bin/env python3
"""Write the coordinator's second 2026-10-10 decision for P5.2 as a later record.

usage: python3 -I build-record-10b.py AUDIT.json > /tmp/2026-10-10b.json, then move it here (an empty record file
in this directory would be read by the step that reads the earlier records, and fail it)

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on P5.2's merge of origin/main ab47a1c11 (378b7033e).
Read with the records before it (2026-10-10.json included), that audit leaves one index.css line without an owner:
`.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row {`, which T7 (3a3c58c1f, "sessions, tasks and
workspaces pick the engine, then a provider it runs") added to main for the composer's Provider menu. The
coordinator (2026-10-10) gave it to P5.3, status new: the menu is WorkspaceView's, and its sibling rule
`.composer-provider-fix` already belongs to P5.3. It goes when P5.3 moves the composer's menus to Orbit's Menu.

The line's facts (kind, text, line number, the commit that wrote it) come from the audit and git blame; only owner,
reason and basis are the decision. It fails if the earlier records leave anything else without an owner or pending,
or if the decision matches no line. (build-record-c.py's index.css part, for P5.2.)
"""
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
EVIDENCE = HERE.parent
ROOT = HERE.parents[3]
CSS = 'src/web/src/index.css'
TEXT = '.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row {'
OWNER = 'P5.3'
REASON = ('输入框 Provider 菜单（composer）里已停用或已删除的会话自身 key 一行的覆盖样式；菜单在 WorkspaceView，随会话工作区的输入框归 '
          'P5.3，与已归 P5.3 的兄弟规则 `.composer-provider-fix` 一起在迁移菜单时改写。')
BASIS = ('协调者 2026-10-10 判定（P5.2 在交证据前合并 origin/main ab47a1c11（378b7033e）后 --check-owners 报出：T7 3a3c58c1f '
         '带进 main 的 index.css 一行，status 记 new，记入 2026-10-10b.json；2026-10-10.json 已被本批占用）。随 P5.3 迁移输入框菜单而消失。')
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-10b.json');
console.log(JSON.stringify({ records: records.map((record) => record.name), ...ownerGaps(report, { ...inventory, records }) }));
"""


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True, capture_output=True, text=True).stdout


def is_ancestor(a, b):
    return subprocess.run(['git', '-C', str(ROOT), 'merge-base', '--is-ancestor', a, b]).returncode == 0


def main():
    audit_path = Path(sys.argv[1]).resolve()
    current = json.load(open(audit_path))
    tip = current['baseline']['commit']
    gaps = json.loads(subprocess.run(['node', '--input-type=module', '-e', GAPS, '--',
                                      (ROOT / 'src/web/scripts/audit-antd.mjs').as_uri(), str(audit_path)],
                                     check=True, capture_output=True, text=True, cwd=ROOT).stdout)
    assert gaps['records'][-1] == '2026-10-10.json', gaps['records']
    assert gaps['pending'] == [], 'the earlier records leave nothing pending'
    assert not [p for p in gaps['unowned'] if 'line' not in p], 'the earlier records leave files without an owner'
    points = [p for p in gaps['unowned'] if 'line' in p]
    assert [(p['path'], p['kind'], p['text']) for p in points] == [(CSS, 'ant-class', TEXT)], points
    baseline = {f['path']: f for f in json.load(open(EVIDENCE / 'audit-baseline.json'))['files']}
    base_count = Counter((h['kind'], h['text']) for h in baseline[CSS]['hits'] if h['kind'] in ('antd-reference', 'ant-class'))
    blamed = {}
    commit = None
    for row in git('blame', '--line-porcelain', tip, '--', CSS).splitlines():
        if m := re.match(r'^([0-9a-f]{40}) \d+ (\d+)', row):
            commit, number = m.group(1), int(m.group(2))
        elif row.startswith('\t'):
            blamed[number] = commit
    at = sorted(p['line'] for p in points)
    introduced = []
    for sha in dict.fromkeys(blamed[n] for n in at):
        short, date, subject = git('log', '-1', '--format=%h%x00%ad%x00%s', '--date=short', sha).strip().split('\0')
        assert is_ancestor(sha, 'origin/main'), f'{short} is not on origin/main'
        introduced.append({'commit': sha, 'short': short, 'date': date, 'subject': subject, 'line': 'main'})
    css = [{'path': CSS, 'kind': 'ant-class', 'text': TEXT, 'count': len(at), 'lines': at,
            'status': 'changed' if base_count[('ant-class', TEXT)] else 'new', 'type': 'css-override',
            'introducedBy': introduced, 'p01Group': None, 'owner': OWNER, 'reason': REASON, 'basis': BASIS}]
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-10',
        'task': '34Za39Mm04q5p66pqUTtj',
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-10',
                     'questions': ['index.css: ' + TEXT]},
        'scan': {'commit': tip, 'scopeHash': current['baseline']['scopeHash'],
                 'command': 'node src/web/scripts/audit-antd.mjs --json', 'counts': current['counts']},
        'files': {},
        'css': css,
        'summary': {'files': 0, 'cssLines': sum(e['count'] for e in css), 'owners': {OWNER: sum(e['count'] for e in css)}},
    }
    json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
