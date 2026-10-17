#!/usr/bin/env python3
"""Write the coordinator's 2026-10-08 decisions for P4.3a as a later record.

usage: python3 -I build-record-08b.py AUDIT.json > 2026-10-08b.json

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on the commit the record is delivered with:
P4.3a's shared components (079c5f006) on the project tip, before P4.3a's page switch -- the last tree in
which the two index.css lines it moves still exist. It records three things:

- `src/web/src/components/ui/Empty.tsx` (new in 079c5f006): its comment names the MIT-licensed Ant Design
  illustrations it adapts and their license file, as ui/SelectEmpty.tsx does (2026-10-07.json, P6). It is
  the only point the earlier records leave without an owner, and it goes to P6 with that precedent.
- index.css "/* The two lines, one under the other; ... antd's own": 2026-10-07.json gave the comment to
  P4.3b as shared by the start card and How it runs, but the rules under it are How it runs' alone
  (`.project-run-lines` is only in ProjectRunSettings.tsx). Reassigned to P4.3a, which closes it with
  the line after it (P4.3a since 2026-10-07c.json).
- index.css ".ant-popover .watch-row-list {": 2026-10-07.json gave it to P4.3a with the task panel, but
  the AntD Popover it qualifies is in WatchRelations.tsx, which is P4.4's. Reassigned to P4.4, to be
  migrated with that Popover.

Facts (category, imports, hit kinds, lines, the commit that brought the file) come from the audit and git;
only owner, reason and basis are the decisions. It fails if the earlier records leave any other point
without an owner, or if a decision matches no point.
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
REPORTED = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch',
            'provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus']
DECISION = '协调者 2026-10-08 判定（P4.3a 开工核实分界后报告：10699 随 P4.3a 关闭，19729 随 WatchRelations.tsx 改归 P4.4，记入 2026-10-08b.json）。'
FILES = {
    'src/web/src/components/ui/Empty.tsx': (
        'P6',
        'Empty 的两幅插图改编自 Ant Design 的 MIT 图形，注释写明出处与许可文件 antd-empty.LICENSE；与 ui/SelectEmpty.tsx 的同一说明一样，'
        '不是 antd 依赖，退役扫描里的这处文字由 P6 处理（保留许可说明或登记为允许的说明）。',
        '按 2026-10-07.json 中 ui/SelectEmpty.tsx（同一许可说明，归 P6）的先例；P4.3b 在 079c5f006 上运行 --check-owners 时报出，'
        'P4.3a 报告协调者。'),
}
# Reassignments of index.css lines, by their text.
CSS_RULES = [
    (r"^/\* The two lines, one under the other; the class makes these rules outrank antd's own$", 'P4.3a',
     '这段注释说明的是 How it runs 的执行模式单选规则；`.project-run-lines` 只在 ProjectRunSettings.tsx 中使用（StartProjectCard 不用），'
     '与下一行（2026-10-07c.json 已归 P4.3a）同属 ProjectRunSettings，由 P4.3a 迁移单选时一并改写关闭。'),
    (r'^\.ant-popover \.watch-row-list \{$', 'P4.4',
     '它限定的 AntD Popover 在 WatchRelations.tsx 中，该文件归 P4.4；不迁移那个 Popover 就改不了这条选择器，随 WatchRelations 一起迁移。'),
]
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-08b.json');
console.log(JSON.stringify({ records: records.map((record) => record.name), ...ownerGaps(report, { ...inventory, records }) }));
"""


def git(*args):
    return subprocess.run(['git', '-C', str(ROOT), *args], check=True, capture_output=True, text=True).stdout


def main():
    audit_path = Path(sys.argv[1]).resolve()
    current = json.load(open(audit_path))
    tip = current['baseline']['commit']
    gaps = json.loads(subprocess.run(['node', '--input-type=module', '-e', GAPS, '--',
                                      (ROOT / 'src/web/scripts/audit-antd.mjs').as_uri(), str(audit_path)],
                                     check=True, capture_output=True, text=True, cwd=ROOT).stdout)
    assert gaps['pending'] == [], 'the earlier records leave nothing pending'
    files_now = {f['path']: f for f in current['files']}

    def symbols(f):
        return {b['imported'] for item in f['imports'] if item['family'] in ('antd', 'react19-patch')
                for b in item['bindings']} | {f"{item['kind']}:{item['module']}" for item in f['imports']
                                              if item['family'] in ('antd', 'react19-patch') and not item['bindings']}

    def kinds(f, which):
        return Counter(h['kind'] for h in f['hits'] if h['kind'] in which)

    def types(f):  # as build-record-c.py
        out = set()
        if symbols(f):
            out.add('antd-import')
        for h in f['hits']:
            k = h['kind']
            if k == 'antd-reference' and not re.search(r"""['"`]antd(?:/[^'"`]*)?['"`]""", h['text']):
                out.add('antd-text')
            elif k == 'ant-selector':
                out.add('ant-selector')
            elif k == 'ant-class' and not re.search(r'\.ant-', h['text']):
                out.add('ant-class')
            elif k in ('provider', 'use-app', 'use-token', 'theme', 'internal-ref', 'react19-patch'):
                out.add({'provider': 'antd-provider', 'use-app': 'antd-use-app', 'use-token': 'antd-theme', 'theme': 'antd-theme'}.get(k, k))
        return sorted(out)

    unowned = sorted(p['path'] for p in gaps['unowned'] if 'line' not in p)
    assert unowned == sorted(FILES), f'unowned files {unowned}, decisions {sorted(FILES)}'
    assert not [p for p in gaps['unowned'] if 'line' in p], 'the earlier records leave index.css lines without an owner'
    files = {}
    for path, (owner, reason, basis) in FILES.items():
        c = files_now[path]
        added = git('log', '--diff-filter=A', '--format=%H%x00%h%x00%ad%x00%s', '--date=short', tip, '--', path).strip().splitlines()[-1].split('\0')
        files[path] = {'status': 'new', 'category': c['category'], 'types': types(c),
                       'antdImports': sorted(symbols(c)), 'hitKinds': dict(sorted(kinds(c, REPORTED).items())),
                       'introducedBy': [{'commit': added[0], 'short': added[1], 'date': added[2], 'subject': added[3], 'line': 'project'}],
                       'p01Owner': None, 'owner': owner, 'reason': reason, 'basis': basis}
    css, used = [], set()
    hits = [h for h in files_now[CSS]['hits'] if h['kind'] in ('antd-reference', 'ant-class')]
    for pattern, owner, reason in CSS_RULES:
        matched = sorted({(h['kind'], h['text']) for h in hits if re.search(pattern, h['text'])})
        assert len(matched) == 1, f'{pattern}: {matched}'
        kind, text = matched[0]
        at = sorted(h['line'] for h in hits if h['kind'] == kind and h['text'] == text)
        used.add(pattern)
        css.append({'path': CSS, 'kind': kind, 'text': text, 'count': len(at), 'lines': at, 'status': 'reassigned',
                    'type': 'antd-text' if kind == 'antd-reference' else 'css-override',
                    'p01Group': 'StartProjectCard/ProjectRunSettings（P4.3）' if owner == 'P4.3a' else 'WatchRelations（P4.3）',
                    'owner': owner, 'reason': reason, 'basis': DECISION})
    assert used == {r[0] for r in CSS_RULES}
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-08',
        'task': '34Za39GvWRQ08ZmKOpFNe',
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-08',
                     'questions': sorted([Path(p).stem for p in files] + ['index.css: ' + e['text'].strip() for e in css])},
        'scan': {'commit': tip, 'scopeHash': current['baseline']['scopeHash'],
                 'command': 'node src/web/scripts/audit-antd.mjs --json', 'counts': current['counts']},
        'files': dict(sorted(files.items())),
        'css': css,
        'summary': {'files': len(files), 'cssLines': sum(e['count'] for e in css),
                    'owners': dict(sorted(Counter([e['owner'] for e in files.values()] + [e['owner'] for e in css for _ in range(e['count'])]).items()))},
    }
    json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
