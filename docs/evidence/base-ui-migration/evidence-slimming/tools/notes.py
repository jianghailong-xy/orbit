# Put the slimming note at the top of every README whose directory the slimming changed (after its title),
# and create README.md for a slimmed task directory that has none. Usage (repository root):
#   python3 -I notes.py <plan.json>
import collections, json, os, posixpath, subprocess, sys

BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
plan = json.load(open(sys.argv[1]))
MARK = '> **证据瘦身（2026-10-07）**'

# Revision verdicts from the coordinators' task_evidence_decide records (evidence-slimming/decisions.json).
SUPERSEDED_NOTE = {
    'p2.1/README.md': '本页是第 1 版（判定 SEND_BACK）。被采用的是[第 2 版](revision-2/README.md)（CONFIRM），第 1 版运行的截图、逐用例 JSON 和压缩包已删除。',
    'p2.2/README.md': '本页是第 1 版（判定 SEND_BACK）。第 2–7 版已被后续修订取代，被采用的是[第 8 版](revision-8/README.md)（最后一次 CONFIRM）。第 1–7 版运行的截图、逐用例 JSON 和压缩包已删除。',
    'p2.2/diagnostics/README.md': '本目录是第 1 版（判定 SEND_BACK）的诊断。被采用的是[第 8 版](../revision-8/README.md)，这里的截图、逐用例 JSON 和 history.tar.gz 已删除。',
    'p2.2/revision-2/README.md': '第 2 版当时判定 CONFIRM，后被第 3–8 版取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。',
    'p2.2/revision-3/README.md': '第 3 版（判定 SEND_BACK）已被后续修订取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。',
    'p2.2/revision-4/README.md': '第 4 版（判定 SEND_BACK）已被后续修订取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 和协调者复核压缩包 p22-r3-coordinator-review.zip 已删除。',
    'p2.2/revision-5/README.md': '第 5 版当时判定 CONFIRM，后被第 6–8 版取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 和协调者复核压缩包 p22-r4-coordinator-review.zip 已删除。',
    'p2.2/revision-6/README.md': '第 6 版（判定 SEND_BACK）已被后续修订取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。',
    'p2.2/revision-7/README.md': '第 7 版当时判定 CONFIRM，后被第 8 版取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。',
    'p2.3/README.md': '本页是第 1 版（判定 SEND_BACK）。第 2 版也被退回，被采用的是[第 3 版](revision-3/README.md)（CONFIRM）。第 1、2 版运行的截图、逐用例 JSON 已删除。',
    'p2.3/revision-2/README.md': '第 2 版（判定 SEND_BACK）已被[第 3 版](../revision-3/README.md)（CONFIRM）取代。本版运行的截图、逐用例 JSON 已删除。',
}
NEW_README_TITLE = {
    'p2-integration-cards': '# P2 集成修复：紧凑决策卡片的 Web 集成回归',
}
NEW_README_BODY = {
    'p2-integration-cards': '服务于 [紧凑决策卡片引入后的 Web 集成回归修复](orbit-task:34a0sy3NmYy7MLbOcqhkW)。本目录原来没有 README，结论和检查记录在 [summary.json](summary.json)、[review.json](review.json) 与 [failure-map.json](failure-map.json)。',
}

changed = [p for p in plan if p['action'] != 'keep']
tracked = set(subprocess.run(['git', 'ls-files', P], capture_output=True, text=True, check=True).stdout.split('\n'))


def counts(d):
    c = collections.Counter(p['action'] for p in changed if p['rel'].startswith(d))
    return c


def note(readme_rel):
    d = posixpath.dirname(readme_rel) + '/'
    c = counts(d)
    parts = []
    if c['report']:
        other = sum(1 for p in changed if p['rel'].startswith(d) and p['action'] == 'report'
                    and posixpath.basename(p['rel']) not in ('report.json', 'report.json.gz'))
        named = '，另有 %d 份其他文件名的报告换成 `<原名>.summary.json`' % other if other else ''
        parts.append(f"{c['report'] - other} 份 Playwright 报告换成同目录的 `report.summary.json`{named}，都只删附件正文")
    if c['trace']:
        parts.append(f"删除 {c['trace']} 个 trace 压缩包")
    if c['superseded']:
        parts.append(f"删除被取代修订的 {c['superseded']} 个原始运行文件（截图、逐用例 JSON、运行压缩包）")
    if c['case']:
        parts.append(f"{c['case']} 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）")
    if c['duplicate']:
        parts.append(f"删除 {c['duplicate']} 张与本任务目录里保留副本逐字节相同的重复截图")
    slim = posixpath.relpath(P + 'evidence-slimming/README.md', posixpath.dirname(P + readme_rel))
    lines = [
        f"{MARK}：完整原件见提交 `{BASE}`（瘦身前最后一个含完整文件的提交）。"
        f"取回单个文件用 `git show {BASE}:docs/evidence/base-ui-migration/{d}<路径> > <文件>`，"
        f"整个目录用 `git archive {BASE} docs/evidence/base-ui-migration/{d.rstrip('/')} | tar -x -C <空目录>`。",
        '>',
        '> 本目录在瘦身中：' + '；'.join(parts) + '。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。',
    ]
    if readme_rel in SUPERSEDED_NOTE:
        lines += ['>', '> ' + SUPERSEDED_NOTE[readme_rel]]
    lines += ['>', f"> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `{BASE[:9]}` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming]({slim})。"]
    return '\n'.join(lines) + '\n'


targets = []
for rel in sorted({p['rel'] for p in plan if posixpath.basename(p['rel']) == 'README.md'}):
    if '/' not in rel or rel.split('/')[0] in ('p0.2', 'p0-drift', 'p0-drift-2') or rel.split('/')[0].endswith('-accepted'):
        continue
    if counts(posixpath.dirname(rel) + '/'):
        targets.append(rel)
for top in sorted({p['rel'].split('/')[0] for p in changed}):
    if top + '/README.md' not in {p['rel'] for p in plan}:
        targets.append(top + '/README.md')

for rel in targets:
    path = P + rel
    if os.path.exists(path):
        text = open(path, encoding='utf-8').read()
        if MARK in text:
            raise SystemExit(f'{rel} already has the note')
        first, rest = text.split('\n', 1)
        if not first.startswith('# '):
            raise SystemExit(f'{rel} does not start with a title')
        out = first + '\n\n' + note(rel) + '\n' + rest.lstrip('\n')
    else:
        top = rel.split('/')[0]
        out = NEW_README_TITLE[top] + '\n\n' + note(rel) + '\n' + NEW_README_BODY[top] + '\n'
    open(path, 'w', encoding='utf-8').write(out)
    print('noted', rel)
