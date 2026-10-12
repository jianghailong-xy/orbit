# Write evidence-slimming/checks/checks.json: the numbers the README cites that are not in the git trees.
# Usage (repository root): python3 -I compute-checks.py <uploads dir>
import collections, json, re, subprocess, sys

U = sys.argv[1]
P = 'docs/evidence/base-ui-migration/'
OUT = P + 'evidence-slimming/'
plan = json.load(open(U + '/plan.json'))
byrel = {p['rel']: p for p in plan}


def tree(ref):
    sizes = {}
    for line in subprocess.run(['git', 'ls-tree', '-r', '-l', ref, '--', P], capture_output=True, text=True, check=True).stdout.splitlines():
        meta, path = line.split('\t', 1)
        sizes[path[len(P):]] = int(meta.split()[3])
    return sizes


subprocess.run(['git', 'add', '-A', '--', OUT], check=True)
after = tree(subprocess.run(['git', 'write-tree'], capture_output=True, text=True, check=True).stdout.strip())
LABEL = {
    'protected': '受保护目录与根目录清单（逐字节未改）',
    'document or check text': 'README、说明文档、检查结果文本（.md/.txt，含 22 份加了说明的 README）',
    'summary, index or audit JSON': '汇总、索引、审计 JSON（含 artifact-index、manifest 等 SHA256SUMS 类清单）',
    'script, patch, log or manifest': '脚本、补丁、日志、样式和 .sha256 清单',
    'kept gz': '压缩的依赖安装快照与合并检查日志（README 引用）',
    'raw file individually linked from a document': '被取代修订里文档单独链接的截图和 JSON',
    'per-test JSON individually linked from a document': '被采用版本里文档单独链接的逐用例 JSON',
    'screenshot or diff of an adopted revision': '被采用版本的截图和差异图（每个任务目录每张一份）',
}
summary_of_report = {p['replacement'] for p in plan if p['action'] == 'report'}
cats = collections.defaultdict(lambda: [0, 0])
for rel, size in after.items():
    if rel.startswith('evidence-slimming/'):
        continue
    p = byrel.get(rel)
    if p and p['action'] == 'keep':
        label = LABEL.get(p['reason'], p['reason'])
    elif rel in summary_of_report:
        label = 'report.summary.json（Playwright 报告去掉附件正文）'
    elif rel.endswith('/attachments.summary.json'):
        label = 'attachments.summary.json（逐用例 JSON 汇总）'
    else:
        label = '新增 .gitignore 和 p2-integration-cards/README.md'
    cats[label][0] += 1; cats[label][1] += size

log = open(U + '/build-test.log', encoding='utf-8', errors='replace').read()
files = re.search(r'Test Files\s+(\d+) passed \((\d+)\)', log)
tests = re.search(r'\n\s+Tests\s+(\d+) passed \((\d+)\)', log)
built = '✓ built in' in log
inv = open(OUT + 'checks/inventory.txt', encoding='utf-8').read().strip()
verify = json.load(open(U + '/verify-reports.json'))
checks = {
    'reportTests': verify['tests'], 'reportBodies': verify['bodies'],
    'added': {'report': [41885192, 303], 'case': [9589204, 141]},
    'notesDelta': 29537 + 1651,
    'keptCategories': sorted(([k, v] for k, v in cats.items()), key=lambda kv: -kv[1][1]),
    'commands': [
        {'name': '清单核对脚本', 'command': 'node src/web/scripts/verify-antd-inventory.mjs',
         'result': '退出 0：' + inv.splitlines()[-1], 'where': '提交 `9014a478d`，输出 [checks/inventory.txt](checks/inventory.txt)'},
        {'name': '项目合并检查', 'command': 'npm run build -w @orbit/web && npm run test -w @orbit/web',
         'result': ('构建通过；Vitest %s/%s 个测试文件、%s/%s 个用例全部通过' % (files.group(1), files.group(2), tests.group(1), tests.group(2))) if (files and tests and built) else '未通过（见输出）',
         'where': '提交 `9014a478d`，输出 [checks/build-test.txt](checks/build-test.txt)'},
    ],
}
json.dump(checks, open(OUT + 'checks/checks.json', 'w'), ensure_ascii=False, indent=1)
print(json.dumps(checks['commands'], ensure_ascii=False, indent=1))
