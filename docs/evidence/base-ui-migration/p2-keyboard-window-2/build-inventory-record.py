#!/usr/bin/env python3
"""Write the coordinator's 2026-10-07 registration of this task's antd Popconfirm import as a later record.

usage: build-inventory-record.py CURRENT.json EARLIER.json > docs/evidence/base-ui-migration/inventory-delta/2026-10-07d.json

CURRENT.json is `node src/web/scripts/audit-antd.mjs --json` on this branch's sources; EARLIER.json is the record it
amends, inventory-delta/2026-10-07.json. The ChoicesFixture.tsx entry of that record is restated with the facts the
audit now has (its antd imports gained Popconfirm, from 5cd02c2ae; nothing else changed) and the owner the coordinator
kept, P6, under status `amended` (the coordinator's choice, 2026-10-07): the current facts of an entry that is already
registered, owner unchanged, `added` counted from that entry. Such an entry is not needed for ownership -- the earlier
entry already gives the file its owner -- so verify-record.mjs's third check (each new, changed or reassigned entry is
needed) does not apply to it. The earlier record stays as it is; the name sorts after it and after 2026-10-07c.json."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

current, earlier = (json.load(open(path)) for path in sys.argv[1:3])
PATH = 'src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx'
AMENDED = ('重述已登记条目（amends 所指记录中的同一路径）的当前事实，owner 不变；added 相对该条目计算。'
           '它不是归属所必需（原条目已给出 owner），所以 verify-record.mjs 第 3 项（拿掉新增/改动或重新归属的条目后的反向对照）不适用。')
COMMIT = '5cd02c2ae6c75f315427f26b87b8ba7838c73b8f'
REPORTED = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch',
            'provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus']
file = next(item for item in current['files'] if item['path'] == PATH)
imports = sorted({binding['imported'] for item in file['imports'] if item['family'] in ('antd', 'react19-patch')
                  for binding in item['bindings']})
kinds = dict(sorted({kind: sum(hit['kind'] == kind for hit in file['hits']) for kind in REPORTED
                     if any(hit['kind'] == kind for hit in file['hits'])}.items()))
entry = earlier['files'][PATH]
assert entry['owner'] == 'P6' and kinds == entry['hitKinds'] and file['category'] == entry['category']
added = sorted(set(imports) - set(entry['antdImports']))
assert added == ['Popconfirm'] and set(entry['antdImports']) <= set(imports)
date, subject = subprocess.run(['git', '-C', str(ROOT), 'show', '-s', '--format=%ad%n%s', '--date=short', COMMIT],
                               capture_output=True, text=True, check=True).stdout.splitlines()
record = {
    'schemaVersion': 1,
    'kind': 'antd-inventory-delta',
    'date': '2026-10-07',
    'task': '34blUhb6Wip3e5nyziKfq',
    'amends': '2026-10-07.json',
    'statusMeaning': {'amended': AMENDED},
    'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-07',
                 'subject': 'ChoicesFixture.tsx 新增的 antd Popconfirm 导入，owner 仍为 P6'},
    'scan': {'commit': current['baseline']['commit'], 'scopeHash': current['baseline']['scopeHash'],
             'command': 'node src/web/scripts/audit-antd.mjs --json', 'counts': current['counts']},
    'files': {PATH: {
        **{key: value for key, value in entry.items() if key not in ('owner', 'reason', 'introducedBy', 'antdImports', 'hitKinds')},
        'status': 'amended',
        'antdImports': imports,
        'hitKinds': kinds,
        'added': {'antdImports': added, 'hitKinds': {}},
        'introducedBy': [*entry['introducedBy'], {'commit': COMMIT, 'short': COMMIT[:9], 'date': date, 'subject': subject, 'line': 'project'}],
        'owner': 'P6',
        'reason': entry['reason'] + '5cd02c2ae 为 P2 跟进（第 2 批窗口）的 Popconfirm 打开窗口基线加入 antd Popconfirm，作旧实现参照，随该样例由 P6 处理。',
        'basis': '协调者 2026-10-07 判定（本任务会话收到的消息）：owner 仍是 P6，理由是它是 Popconfirm 基线的 AntD 参照。',
    }},
    'css': [],
    'summary': {'files': 1, 'cssLines': 0, 'owners': {'P6': 1}},
}
json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
print()
