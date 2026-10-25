#!/usr/bin/env python3
"""Write the coordinator's 2026-10-09 decision for P4.3b as a later record.

usage: python3 -I build-record-09.py AUDIT.json > 2026-10-09.json

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on the P4.3b delivery the record is delivered
with, before the record itself. It records one thing:

- `src/web/src/firstPageStylesheet.test.ts` (new in P4.3b's stylesheet fix): it holds the order of the first
  page's one stylesheet, and the order it expects names `antd/dist/reset.css` between the three stylesheets
  main.tsx imports first and index.css. That name is the audit's antd reference. It goes to P6, which takes
  the reset out of main.tsx and so takes it out of this expectation too, with the precedents of
  ProjectDoneConversation.test.tsx (2026-10-07c.json) and ui/Empty.tsx (2026-10-08b.json).

Facts (category, imports, hit kinds, the commit that brought the file) come from the audit and git; only
owner, reason and basis are the decision. It fails if the decision matches no point, or if, without this record,
the other records (those before it and those after it) leave any other point without an owner.
(build-record-08b.py, without its index.css part.)

Since P4.3a landed, 2026-10-09b.json sorts after this record and owns three Infrastructure test files main
brought (App.infrastructure.test.tsx, InfrastructurePage.overview.test.tsx, RunnerDetailPage.engines.test.tsx).
The records before this one leave those three without an owner too: they are 09b's, which is checked here
rather than assumed.
"""
import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
REPORTED = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch',
            'provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus']
FILES = {
    'src/web/src/firstPageStylesheet.test.ts': (
        'P6',
        '这个测试钉住首屏唯一样式表的顺序，期望里写着 antd/dist/reset.css（位于 main.tsx 先导入的三份样式与 index.css 之间），'
        '审计把这个名字记为 antd 引用；不是 antd 依赖。P6 从 main.tsx 去掉 antd reset 时，同时去掉期望里的这一项。',
        '协调者 2026-10-09 判定，按 2026-10-07c.json 中 ProjectDoneConversation.test.tsx、2026-10-08b.json 中 ui/Empty.tsx（都归 P6）的先例；'
        'P4.3b 跟上项目 tip 15b7b5609 并合并 origin/main f1837de8e 后在交付上运行 --check-owners 时报出，P4.3b 报告协调者。'),
}
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-09.json');
const others = inventory.records.filter((record) => record.name !== '2026-10-09.json');
console.log(JSON.stringify({ records: records.map((record) => record.name), ...ownerGaps(report, { ...inventory, records }),
  others: { records: others.map((record) => record.name), ...ownerGaps(report, { ...inventory, records: others }) } }));
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

    # Without this record the other records, earlier and later, leave exactly its files unowned; the records before
    # it leave those and the points a later record owns (2026-10-09b: three Infrastructure test files).
    others = gaps['others']
    assert others['pending'] == [], 'the other records leave nothing pending'
    unowned = sorted(p['path'] for p in others['unowned'] if 'line' not in p)
    assert unowned == sorted(FILES), f'unowned files without this record {unowned}, decisions {sorted(FILES)}'
    assert not [p for p in others['unowned'] if 'line' in p], 'the other records leave index.css lines without an owner'
    before = sorted(p['path'] for p in gaps['unowned'] if 'line' not in p)
    assert set(FILES) <= set(before), f'the earlier records already own {sorted(set(FILES) - set(before))}'
    files = {}
    for path, (owner, reason, basis) in FILES.items():
        c = files_now[path]
        added = git('log', '--diff-filter=A', '--format=%H%x00%h%x00%ad%x00%s', '--date=short', tip, '--', path).strip().splitlines()[-1].split('\0')
        files[path] = {'status': 'new', 'category': c['category'], 'types': types(c),
                       'antdImports': sorted(symbols(c)), 'hitKinds': dict(sorted(kinds(c, REPORTED).items())),
                       'introducedBy': [{'commit': added[0], 'short': added[1], 'date': added[2], 'subject': added[3], 'line': 'project'}],
                       'p01Owner': None, 'owner': owner, 'reason': reason, 'basis': basis}
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-09',
        'task': '34blYpxEcHMAf4oafuC2W',
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-09',
                     'questions': sorted(Path(p).name for p in files)},
        'scan': {'commit': tip, 'scopeHash': current['baseline']['scopeHash'],
                 'command': 'node src/web/scripts/audit-antd.mjs --json', 'counts': current['counts']},
        'files': dict(sorted(files.items())),
        'css': [],
        'summary': {'files': len(files), 'cssLines': 0,
                    'owners': dict(sorted(Counter(e['owner'] for e in files.values()).items()))},
    }
    json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
    print()


if __name__ == '__main__':
    main()
