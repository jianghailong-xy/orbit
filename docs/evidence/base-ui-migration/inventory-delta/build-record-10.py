#!/usr/bin/env python3
"""Write the coordinator's 2026-10-10 decision for P5.2 as a later record.

usage: python3 -I build-record-10.py AUDIT.json > 2026-10-10.json

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on P5.2's delivery (its business switch and comparison spec
on the project tip d580e572d, which already holds origin/main 46e28aaa3). At P5.2's start `--check-owners` reported one
point no record owns: WorkspaceView.recapRow.test.tsx, which main's session-list recap (2255a5313, 0418) brought in and
which wraps the session workspace it tests in antd's App, as WorkspaceView.managedRunner.test.tsx does (2026-10-09c.json).
The coordinator (2026-10-10) gave it to P5.3, status new, as the other WorkspaceView.*.test.tsx are. P5.2's own points
are gone on that commit, so this is the only one the record has to account for. The name is 2026-10-10.json: no record
of that day exists yet.

Facts (category, imports, hit kinds, the commit that brought the file) come from the audit and git; only owner,
reason and basis are the decision. It fails if the earlier records leave any other point without an owner or
anything pending, or if a decision matches no point. (build-record-09c.py, for P5.2.)
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
REASON = ('WorkspaceView 的测试，只用 antd 的 App 包裹被测的会话工作区；会话工作区由 P5.3 迁移，与其余 '
          'WorkspaceView.*.test.tsx 一起去掉这个包裹。')
BASIS = ('协调者 2026-10-10 判定（P5.2 开工时在项目 tip d580e572d（已含 origin/main 46e28aaa3）上 --check-owners 报出：main 的'
         '会话列表 recap（2255a5313，0418）带进的测试文件，status 记 new，记入 2026-10-10.json；与 2026-10-09c.json 的 '
         'WorkspaceView.managedRunner.test.tsx 同形）。随 P5.3 去掉包裹而消失。')
FILES = {'src/web/src/components/WorkspaceView.recapRow.test.tsx': ('P5.3', REASON, BASIS)}
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-10.json');
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
                       'introducedBy': [{'commit': added[0], 'short': added[1], 'date': added[2], 'subject': added[3], 'line': 'main'}],
                       'p01Owner': None, 'owner': owner, 'reason': reason, 'basis': basis}
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-10',
        'task': '34Za39Mm04q5p66pqUTtj',
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-10',
                     'questions': sorted(Path(p).stem for p in files)},
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
