#!/usr/bin/env python3
"""Write the coordinator's 2026-10-08 registration of this task's antd Drawer import as a later record.

usage: build-inventory-record.py CURRENT.json EARLIER.json > docs/evidence/base-ui-migration/inventory-delta/2026-10-08.json

CURRENT.json is `node src/web/scripts/audit-antd.mjs --json` on this branch's sources; EARLIER.json is the record it
amends, inventory-delta/2026-10-07d.json, the latest statement of the ChoicesFixture.tsx entry. That entry is restated
with the facts the audit now has (its antd imports gained Drawer, the replaced drawer the first-frame checks place a
sample in, from INTRODUCED; nothing else changed) and the owner the coordinator kept, P6, under status `amended`, as
2026-10-07d.json did: the current facts of an entry that is already registered, owner unchanged, `added` counted from
that entry, not needed for ownership. The earlier records stay as they are; the name sorts after all 2026-10-07 ones.
INTRODUCED is the commit that added the import (the first argument after the two files, a full commit id)."""
import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]

current, earlier = (json.load(open(path)) for path in sys.argv[1:3])
introduced = sys.argv[3]
PATH = 'src/web/src/components/ui/__fixtures__/ChoicesFixture.tsx'
AMENDED = ('重述已登记条目（amends 所指记录中的同一路径）的当前事实，owner 不变；added 相对该条目计算。'
           '它不是归属所必需（原条目已给出 owner），所以 verify-record.mjs 第 3 项（拿掉新增/改动或重新归属的条目后的反向对照）不适用。')
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
assert added == ['Drawer'] and set(entry['antdImports']) <= set(imports)
date, subject = subprocess.run(['git', '-C', str(ROOT), 'show', '-s', '--format=%ad%n%s', '--date=short', introduced],
                               capture_output=True, text=True, check=True).stdout.splitlines()
record = {
    'schemaVersion': 1,
    'kind': 'antd-inventory-delta',
    'date': '2026-10-08',
    'task': '34broktJh4EJXI1eiF7Jm',
    'amends': '2026-10-07d.json',
    'statusMeaning': {'amended': AMENDED},
    'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-08',
                 'subject': 'ChoicesFixture.tsx 新增的 antd Drawer 导入，owner 仍为 P6'},
    'scan': {'commit': current['baseline']['commit'], 'scopeHash': current['baseline']['scopeHash'],
             'command': 'node src/web/scripts/audit-antd.mjs --json', 'counts': current['counts']},
    'files': {PATH: {
        **{key: value for key, value in entry.items() if key not in ('owner', 'reason', 'basis', 'introducedBy', 'antdImports', 'hitKinds', 'added')},
        'status': 'amended',
        'antdImports': imports,
        'hitKinds': kinds,
        'added': {'antdImports': added, 'hitKinds': {}},
        'introducedBy': [*entry['introducedBy'], {'commit': introduced, 'short': introduced[:9], 'date': date, 'subject': subject, 'line': 'project'}],
        'owner': 'P6',
        'reason': entry['reason'] + f'{introduced[:9]} 为浮层第一帧位置检查加入 antd Drawer，作「抽屉内」位置的旧实现参照，随该样例由 P6 处理。',
        'basis': '协调者 2026-10-08 判定（本任务会话收到的消息）：按 2026-10-07d.json 的先例补记录，status amended，owner 仍是 P6。',
    }},
    'css': [],
    'summary': {'files': 1, 'cssLines': 0, 'owners': {'P6': 1}},
}
json.dump(record, sys.stdout, indent=1, ensure_ascii=False)
print()
