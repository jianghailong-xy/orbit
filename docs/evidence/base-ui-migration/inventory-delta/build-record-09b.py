#!/usr/bin/env python3
"""Write the coordinator's 2026-10-09 decision for P4.3a as a later record.

usage: python3 -I build-record-09b.py AUDIT.json > 2026-10-09b.json

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on the commit the record is delivered with: P4.3a's
delivery (dac57bade) after catching up with origin/main 19c760ae4. Main brought three test files from another
project's Infrastructure page (34bmzOkov3xN2yLPrnsCk) that no record owns; each wraps what it tests in antd's App
(InfrastructurePage and RunnerDetailPage themselves import no antd). The coordinator gave all three to P6, which
removes ConfigProvider/AntApp and these wrappers with them, as 2026-10-07c.json did ProjectDoneConversation.test.tsx.
The name is 2026-10-09b.json because 2026-10-09.json is kept for P4.3b, which lands after P4.3a.

Facts (category, imports, hit kinds, the commit that brought the file) come from the audit and git; only owner,
reason and basis are the decision. It fails if the earlier records leave any other point without an owner or
anything pending, or if a decision matches no point.
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
REASON = ('只用 antd 的 App 包裹被测组件，被测的 InfrastructurePage 与 RunnerDetailPage 本身不导入 antd；P6 去掉 ConfigProvider/AntApp '
          '时连同这些测试包裹一起去掉。')
BASIS = ('协调者 2026-10-09 判定（P4.3a 跟上 origin/main 19c760ae4 后 --check-owners 报出：另一个项目 34bmzOkov3xN2yLPrnsCk 的 '
         'Infrastructure 页带进 main 的三个测试文件，status 记 new，记入 2026-10-09b.json；2026-10-09.json 留给 P4.3b）。'
         '先例为 2026-10-07c.json 把 ProjectDoneConversation.test.tsx 归 P6。')
FILES = {path: ('P6', REASON, BASIS) for path in (
    'src/web/src/App.infrastructure.test.tsx',
    'src/web/src/pages/InfrastructurePage.overview.test.tsx',
    'src/web/src/pages/RunnerDetailPage.engines.test.tsx',
)}
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-09b.json');
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
        'date': '2026-10-09',
        'task': '34Za39GvWRQ08ZmKOpFNe',
        'decision': {'by': 'coordinator', 'session': '34b245G3NiwgVVUj2JFJw', 'date': '2026-10-09',
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
