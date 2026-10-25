#!/usr/bin/env python3
"""Write the coordinator's decisions on the use points that came after the 2026-10-07 records, as a later record.

usage: python3 -I build-record-c.py AUDIT.json > 2026-10-07c.json

AUDIT.json is `node src/web/scripts/audit-antd.mjs --json` on the commit the record is delivered with
(P4.2, rebased on origin/main). Read with only 2026-10-07.json and 2026-10-07b.json, that audit leaves
a handful of points without an owner, all brought by main. The coordinator decided them on 2026-10-08:
first from what --check-owners reported once the second batch's window follow-up was rebased on
origin/main c7efa24cb -- P4.2 migrates DeepSeekBalance.tsx and RunnerEngines.accountFold.test.tsx itself
(so they are use points no longer, and not here), the rest get the owners below -- then, sending P4.2's
first evidence back, WikiReviewPage.decided.test.tsx, the three points of main's Wiki sharing the
project tip reported next, and WorkspaceView.promptSuggestion.test.tsx (P4.2 migrates X1's
AdminUsersPage.disable.test.tsx itself, so it is not here either). ProjectDoneConversation.test.tsx had the same
decision on 2026-10-07 (precedent: ProjectWhyNotDoneGate.test.tsx in 2026-10-07.json). 2026-10-07d.json
sorts after this record and only amends an entry of 2026-10-07.json, so it is not read here.

The points are the audit's own (`ownerGaps`, run by node over the two earlier records); their facts --
status, category, antd imports, hit kinds, what grew since P0.1, the commits that brought them, the
index.css lines -- come from the audit, the P0.1 baseline and git blame. Only owner, reason and basis are
the decisions. It fails if a point has no decision or a decision matches no point.
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
P01 = '1068a14b899911838526111b6814394e99762aaf'
REPORTED = ['antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch',
            'provider', 'theme', 'imperative-confirm', 'imperative-feedback', 'ref-focus']
USE = ('antd-reference', 'ant-class', 'ant-selector', 'internal-ref', 'use-app', 'use-token', 'react19-patch')
BASIS = '协调者 2026-10-08 判定（第 2 批窗口跟进 rebase 到 origin/main c7efa24cb 后 --check-owners 报出的未归属点）。'
BASIS_WIKI = '协调者 2026-10-08 判定（项目 tip 上新报出的 Wiki 分享改动，都归 P4.4）。'
FILES = {
    'src/web/src/components/ProjectDoneConversation.test.tsx': (
        'P6',
        '只有测试数据里的 “antd migration”（以本项目为例的固定数据名），不是 antd 依赖；退役扫描里的这处文字由 P6 改名或登记为允许的说明。',
        BASIS + '2026-10-07 已作同样判定，先例为 2026-10-07.json 的 ProjectWhyNotDoneGate.test.tsx。'),
    'src/web/src/components/StartProjectCard.test.tsx': (
        'P4.3b',
        'Start 卡片（StartProjectCard）的测试，main 50e7ca040 起用了 .ant-select-content 选择器；Start 卡片归 P4.3b，测试随它迁移。',
        BASIS),
    'src/web/src/components/WikiReviewPage.decided.test.tsx': (
        'P4.4',
        'main 6ec468a25 新增的 Review 决定后状态测试，以 AntD App 包裹并用 .ant-modal 等选择器；WikiReviewPage 归 P4.4，测试随它迁移。',
        '协调者 2026-10-08 判定（退回 P4.2 第 1 版证据时：归 P4.4，写进重建的 07c）。'),
    'src/web/src/components/WikiShareButton.tsx': (
        'P4.4',
        'main 2ba6765d9 新增的 Wiki 分享按钮，导入 antd Button；Wiki 页面归 P4.4，按钮随它迁移。',
        BASIS_WIKI),
    'src/web/src/components/WorkspaceView.neverStarted.test.tsx': (
        'P5.3',
        'main 622c30e1f 新增的 WorkspaceView 测试，以 AntD App 包裹；随会话工作区归 P5.3。',
        BASIS),
    'src/web/src/components/WorkspaceView.promptSuggestion.test.tsx': (
        'P5.3',
        'main def134095 新增的输入框建议回复测试，以 AntD App 包裹；随会话工作区归 P5.3（先例为同一记录的 WorkspaceView.neverStarted.test.tsx）。',
        '协调者 2026-10-08 判定（rebase 到 origin/main def134095 后 --check-owners 报出的未归属点）。'),
    'src/web/src/pages/SharedWikiPage.tsx': (
        'P4.4',
        'main 2ba6765d9 新增的公开分享 Wiki 页（/s/:token），导入 antd Drawer、Popover；公开分享页归 P4.4。',
        BASIS_WIKI),
    'src/web/src/pages/SharedWikiPage.test.tsx': (
        'P4.4',
        'SharedWikiPage 的测试，用 .ant-popover 选择器；随页面归 P4.4。',
        BASIS_WIKI),
}
# index.css lines, by their text.
CSS_RULES = [
    (r'^\.ant-dropdown-menu-item\.composer-engine-title', 'P5.3', '输入框引擎菜单（composer）里标题项的覆盖样式；随会话工作区的输入框归 P5.3。'),
    (r'\.ant-radio-group', 'P4.3a', '项目运行设置（project-run）一段注释提到被替换的 .ant-radio-group / .ant-radio-wrapper；project-run 设置归 P4.3a。'),
]
GAPS = """
import { readFileSync } from 'node:fs';
const { loadInventory, ownerGaps } = await import(process.argv[1]);
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const inventory = loadInventory();
const records = inventory.records.filter((record) => record.name < '2026-10-07c.json');
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
    assert gaps['records'] == ['2026-10-07.json', '2026-10-07b.json'], gaps['records']
    assert gaps['pending'] == [], 'the earlier records leave nothing pending'
    baseline = {f['path']: f for f in json.load(open(EVIDENCE / 'audit-baseline.json'))['files']}
    ownership = json.load(open(EVIDENCE / 'ownership.json'))['files']
    test_phase, phase = {}, None
    for line in open(EVIDENCE / 'routes-and-tests.md'):
        if m := re.match(r'^### (P[\d.]+) ', line):
            phase = m.group(1)
        if (m := re.match(r'^\| `([^`]+\.(?:test|spec)\.[^`]+)` \|', line)) and phase:
            test_phase['src/web/src/' + m.group(1)] = phase
    files_now = {f['path']: f for f in current['files']}
    cache, blames = {}, {}

    def commit_info(commit):
        if commit not in cache:
            short, date, subj = git('log', '-1', '--format=%h%x00%ad%x00%s', '--date=short', commit).strip().split('\0')
            assert is_ancestor(commit, 'origin/main'), f'{short} is not on origin/main'
            cache[commit] = {'commit': commit, 'short': short, 'date': date, 'subject': subj, 'line': 'main'}
        return cache[commit]

    def blame(path):
        if path not in blames:
            lines, commit = {}, None
            for row in git('blame', '--line-porcelain', tip, '--', path).splitlines():
                if m := re.match(r'^([0-9a-f]{40}) \d+ (\d+)', row):
                    commit, number = m.group(1), int(m.group(2))
                elif row.startswith('\t'):
                    lines[number] = commit
            blames[path] = lines
        return blames[path]

    def symbols(f):
        return {b['imported'] for item in f['imports'] if item['family'] in ('antd', 'react19-patch')
                for b in item['bindings']} | {f"{item['kind']}:{item['module']}" for item in f['imports']
                                              if item['family'] in ('antd', 'react19-patch') and not item['bindings']}

    def kinds(f, which):
        return Counter(h['kind'] for h in f['hits'] if h['kind'] in which)

    def types(f):
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

    files, css, used = {}, [], set()
    for point in (p for p in gaps['unowned'] if 'line' not in p):
        path = point['path']
        assert path in FILES, f'no decision for {path} ({point["reason"]})'
        used.add(path)
        owner, reason, basis = FILES[path]
        c, b = files_now[path], baseline.get(path)
        grown_symbols = sorted(symbols(c) - (symbols(b) if b else set()))
        kc, kb = kinds(c, USE), (kinds(b, USE) if b else Counter())
        grown_kinds = {k: kc[k] - kb.get(k, 0) for k in sorted(kc) if kc[k] > kb.get(k, 0)}
        status = 'new' if not b else ('changed' if grown_symbols or grown_kinds else 'reassigned')
        lines = blame(path)
        commits = [lines[n] for n in sorted({h['line'] for h in c['hits'] if h['kind'] in REPORTED}
                                            | {i['line'] for i in c['imports'] if i['family'] in ('antd', 'react19-patch')})
                   if not is_ancestor(lines[n], P01)]
        if not b:
            commits.insert(0, git('log', '--diff-filter=A', '--format=%H', tip, '--', path).split()[-1])
        entry = {'status': status, 'category': c['category'], 'types': types(c), 'antdImports': sorted(symbols(c)),
                 'hitKinds': dict(sorted(kinds(c, REPORTED).items()))}
        if status == 'changed':
            entry['added'] = {'antdImports': grown_symbols, 'hitKinds': grown_kinds}
        entry.update({'introducedBy': sorted((commit_info(x) for x in dict.fromkeys(commits)), key=lambda i: (i['date'], i['short'])),
                      'p01Owner': ownership.get(path, {}).get('phase') or test_phase.get(path),
                      'owner': owner, 'reason': reason, 'basis': basis})
        files[path] = entry
    base_count = Counter((h['kind'], h['text']) for h in baseline[CSS]['hits'] if h['kind'] in ('antd-reference', 'ant-class'))
    groups = {}
    for point in (p for p in gaps['unowned'] if 'line' in p):
        assert point['path'] == CSS, point
        groups.setdefault((point['kind'], point['text']), []).append(point['line'])
    lines = blame(CSS)
    for (kind, text), at in sorted(groups.items(), key=lambda kv: min(kv[1])):
        rule = next((r for r in CSS_RULES if re.search(r[0], text)), None)
        assert rule, f'no decision for index.css: {text}'
        used.add(rule[0])
        css.append({'path': CSS, 'kind': kind, 'text': text, 'count': len(at), 'lines': sorted(at),
                    'status': 'changed' if base_count[(kind, text)] else 'new',
                    'type': 'antd-text' if kind == 'antd-reference' else 'css-override',
                    'introducedBy': sorted((commit_info(x) for x in dict.fromkeys(lines[n] for n in sorted(at))), key=lambda i: (i['date'], i['short'])),
                    'p01Group': None, 'owner': rule[1], 'reason': rule[2], 'basis': BASIS})
    unused = (set(FILES) | {r[0] for r in CSS_RULES}) - used
    assert not unused, f'decisions that match no point: {sorted(unused)}'
    record = {
        'schemaVersion': 1,
        'kind': 'antd-inventory-delta',
        'date': '2026-10-08',
        'task': '34Za39Feocgj42rrBYwzl',
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
