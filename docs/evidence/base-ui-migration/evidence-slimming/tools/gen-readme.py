# Write docs/evidence/base-ui-migration/evidence-slimming/: README.md and sizes.json, from the recorded data.
# Usage (repository root): python3 -I gen-readme.py <uploads dir>
# The table's "after" column is the git index (git write-tree; git ls-tree -r -l sizes), so stage the directory
# first; the script repeats until the README's own size is part of the totals it prints.
import collections, json, os, subprocess, sys

U = sys.argv[1]
BASE = '7732f14f82d4e6b4406d7d164c4b672f63aa0f56'
P = 'docs/evidence/base-ui-migration/'
OUT = P + 'evidence-slimming/'
plan = json.load(open(U + '/plan.json'))
protected_reports = json.load(open(OUT + 'protected-reports.json'))
decisions = json.load(open(OUT + 'decisions.json'))
samples = json.load(open(OUT + 'sample-retrieval.json'))['samples']
p0 = {k: json.load(open(OUT + f'p0/{k}-meta.json')) for k in ('before', 'after')}
compare = json.load(open(OUT + 'p0/compare.json'))
checks = json.load(open(OUT + 'checks/checks.json'))


def tree(ref):
    out = subprocess.run(['git', 'ls-tree', '-r', '-l', ref, '--', P], capture_output=True, text=True, check=True).stdout
    sizes = {}
    for line in out.splitlines():
        meta, path = line.split('\t', 1)
        sizes[path[len(P):]] = int(meta.split()[3])
    return sizes


def by_dir(sizes):
    agg = collections.defaultdict(lambda: [0, 0])
    for rel, s in sizes.items():
        k = rel.split('/')[0] + '/' if '/' in rel else '(根目录文件)'
        agg[k][0] += s; agg[k][1] += 1
    return agg


def n(x):
    return f'{x:,}'


before = tree(BASE)
bd = by_dir(before)
PROTECTED = {'p0.2/', 'p0-drift/', 'p0-drift-2/', 'p3.2-accepted/', '(根目录文件)'}

COMMITS = [
    ('ad71bbaa5', 'report.json（及 7 份带附件正文的其他文件名报告、1 份 report.json.gz）换成同目录的 report.summary.json，只删附件正文', 'report'),
    ('98f5ea38c', '删除 trace 压缩包', 'trace'),
    ('2d351e482', '删除被取代修订（P2.1 第 1 版、P2.2 第 1–7 版、P2.3 第 1–2 版）的截图、逐用例 JSON 和运行压缩包', 'superseded'),
    ('394a25c85', '被采用版本里的逐用例 JSON 换成所在目录的 attachments.summary.json', 'case'),
    ('ed5ae324c', '删除同一任务目录里逐字节相同的重复截图', 'duplicate'),
]
ADOPTED = [
    ('p1.1/', '34Za38yCyTgCjo2t8Bmi4', 'P1.1', '第 1 版 CONFIRM', '第 1 版'),
    ('p1.1-integration/', '34ZnH5biBaQVTpb6qKIh5', 'P1.1 集成依赖修复', '第 1 版 CONFIRM', '第 1 版（本次未改动）'),
    ('p1.2/', '34Za391ERoVi0sWSzRhvD', 'P1.2', '第 1 版 CONFIRM', '第 1 版'),
    ('p2.1/', '34Za393HPMLVyuXAdfv3j', 'P2.1', '第 1 版 SEND_BACK；第 2 版 CONFIRM', '第 2 版 `revision-2/`'),
    ('p2.2/', '34Za394q2ZEgr7TKprjkF', 'P2.2', '第 1、3、4、6 版 SEND_BACK；第 2、5、7 版 CONFIRM 后被后续修订取代；第 8 版 CONFIRM', '第 8 版 `revision-8/`'),
    ('p2.3/', '34Za3974yqnhjQsRBl0R3', 'P2.3', '第 1、2 版 SEND_BACK；第 3 版 CONFIRM', '第 3 版 `revision-3/`'),
    ('p2.3-b1/', '34bQk0jlytjFYyi4OgLMK', 'P2.3 回归修复 B1', '第 1 版 CONFIRM', '第 1 版'),
    ('p2-integration-cards/', '34a0sy3NmYy7MLbOcqhkW', '紧凑决策卡片集成修复', '第 1 版 CONFIRM', '第 1 版'),
    ('p2-keyboard-window/', '34b7qz5n4yA7s4fJmHNDn', 'P2 跟进（Menu/Select 窗口按键）', '第 1 版 CONFIRM', '第 1 版'),
    ('p2-promotion-toast/', '34a3I43L28Ca0NpMy6Fe8', 'P2 晋升冲突修复', '第 1 版 CONFIRM', '第 1 版'),
    ('p2-select-keys/', '34b4miWykA9R4izIml42v', 'P2 修复（Select 快速连按）', '第 1 版 CONFIRM', '第 1 版'),
    ('p3.1/', '34Za398jkGI2ymxpFlbf2', 'P3.1', '第 1 版 CONFIRM', '第 1 版'),
    ('p3.2/', '34Za39ACSBoCkYKc80Md8', 'P3.2', '第 1 版 CONFIRM；第 2 版（落地冲突返工，沿用第 1 版部分运行）CONFIRM', '第 2 版（含其沿用的第 1 版运行）'),
]


def render(after, self_size):
    ad = by_dir(after)
    total_b, total_a = sum(before.values()), sum(after.values())
    L = []
    w = L.append
    w('# 证据瘦身：从树里移除原始 Playwright 产物')
    w('')
    w(f'服务于 [证据瘦身：从树里移除原始 Playwright 产物](orbit-task:34bmAdTEaU6RjOFacPare)（项目验收 key `6QXvm6WUbzep2HRIVGXjvu`）。'
      f'起点是项目分支 tip `{BASE}`，它就是瘦身前最后一个含完整文件的提交：本次删掉或改写的每个文件都能用 '
      f'`git show {BASE}:docs/evidence/base-ui-migration/<路径>` 取回，整个目录用 `git archive {BASE} docs/evidence/base-ui-migration/<目录> | tar -x -C <空目录>`。历史提交没有改动，改动只在 `docs/evidence/base-ui-migration/` 内。')
    w('')
    w('## 结果')
    w('')
    w(f'- 证据目录（`git ls-tree -r -l` 的字节求和）：**{n(total_b)} 字节 / {n(len(before))} 个文件 → {n(total_a)} 字节 / {n(len(after))} 个文件**，含本目录（{n(self_size)} 字节）。')
    w(f'- 树里没有 trace 压缩包。受保护目录以外没有 Playwright 报告原件：{sum(1 for p in plan if p["action"] == "report")} 份报告都换成了同目录的 `report.summary.json`（或 `<原名>.summary.json`），逐份核对过与原件去掉 `attachments[].body` 后完全相同，共保留 {n(checks["reportTests"])} 条用例结果、删掉 {n(checks["reportBodies"])} 个附件正文。')
    w('- p0.2、p0-drift、p0-drift-2、p3.2-accepted（p0-drift-3、inventory-delta 尚未落地）和根目录清单文件逐字节未改；src/web 代码读取的证据文件和证据目录以外 Markdown 链接到的文件都还在（见「验证」）。')
    w('- [.gitignore](../.gitignore) 忽略 `trace.zip`、`*-trace.zip` 和 `report.json`，防止再提交。')
    w('')
    w('| 目录 | 瘦身前 字节 | 文件 | 瘦身后 字节 | 文件 | 说明 |')
    w('| --- | ---: | ---: | ---: | ---: | --- |')
    keys = sorted(set(bd) | set(ad), key=lambda k: (k == '(根目录文件)', k == 'evidence-slimming/', k.rstrip('/')))
    for k in keys:
        b, a = bd.get(k, [0, 0]), ad.get(k, [0, 0])
        note = ('6 个清单文件未改，新增 .gitignore' if k == '(根目录文件)' else '受保护，未改') if k in PROTECTED else ('本任务新增' if k == 'evidence-slimming/' else ('未改' if b == a else ''))
        w(f'| `{k}` | {n(b[0])} | {n(b[1])} | {n(a[0])} | {n(a[1])} | {note} |')
    w(f'| **合计** | **{n(total_b)}** | **{n(len(before))}** | **{n(total_a)}** | **{n(len(after))}** | |')
    w('')
    w('逐目录数字也在 [sizes.json](sizes.json)。逐文件的删除/替换清单在 [removed.tsv.gz](removed.tsv.gz)：路径、字节数、起点提交里的 git blob、处理方式，以及替换文件或保留副本的路径（`zcat removed.tsv.gz | grep <路径>`）。')
    w('')
    w('## 提交')
    w('')
    w('删除和改写各在独立提交里，提交信息写明删掉的体积：')
    w('')
    w('| 提交 | 内容 | 删除 | 新增 |')
    w('| --- | --- | ---: | ---: |')
    for sha, what, act in COMMITS:
        rm = [p for p in plan if p['action'] == act]
        add = checks['added'].get(act, [0, 0])
        w(f'| `{sha}` | {what} | {n(sum(p["size"] for p in rm))} 字节 / {n(len(rm))} 个 | {n(add[0])} 字节 / {n(add[1])} 个 |')
    w(f'| `9014a478d` | 22 份 README 顶部加瘦身说明，p2-integration-cards 新建 README，新建 `.gitignore` | 0 | 说明 +{n(checks["notesDelta"])} 字节 |')
    w('| （本提交） | 本目录 | 0 | 见上表 |')
    w('')
    w('## 规则')
    w('')
    w('1. **受保护，逐字节不动**：`p0.2/`、`p0-drift/`、`p0-drift-2/`、所有 `*-accepted/`（现有 `p3.2-accepted/`）、根目录文件（ownership.json、audit-baseline.json、css-ownership.json、component-contracts.md、routes-and-tests.md、README.md）。`p0-drift-3/`、`inventory-delta/` 在起点还没落地。')
    w('2. **代码读取的文件**：动手前用 `git grep` 核对了 src/web 和 scripts 里读取证据目录的代码。src/web/ui-migration 的 expected-screenshots.mjs、environment.mjs、composer-checks.mjs、controls.browser.mjs、foundation.browser.mjs、collect-evidence.mjs 只读 p0.2、p0-drift 和 p0-drift-2 下的文件，另外 expected-screenshots.mjs 要求两份判定文档存在：`p2.3-b1/README.md`、`p3.2/README.md`（都保留）。src/web/scripts/verify-antd-inventory.mjs 只读根目录清单文件。scripts/ 里没有读这个目录的代码（只读 docs/evidence/deepseek-harness）。')
    w('3. **证据目录以外的 Markdown 链接**：全仓库 Markdown 只链接到 6 个文件，都是 README（`README.md`、`p0.2/`、`p1.1/`、`p1.2/`、`p2.2/`、`p3.1/` 的 README），都保留。')
    w('4. **Playwright 报告**：`report.json`（及 `report.json.gz`、带附件正文的其他文件名报告）换成同目录的 `report.summary.json`：原报告只删 `attachments[].body`，用例标题、项目、状态、耗时、重试、错误、stdout/stderr、步骤和附件路径全部保留。原文件删除。')
    w('5. **trace 压缩包**：全部删除（`trace.zip`、`<项目>--<用例>--trace.zip` 及其他 `*trace.zip`）。')
    w('6. **被取代、没被采用的修订**：按下表的判定记录，删除截图、逐用例 JSON 和运行压缩包；README、检查结果文本（.md/.txt）、汇总/索引/审计 JSON、脚本、补丁和日志保留。有文档单独链接的 27 个小文件（截图和 JSON，共 0.7 MB）保留，链接不断。运行压缩包即使有文档链接也按原始运行输出删除：`p2.2/diagnostics/history.tar.gz` 是第 1 版诊断运行约 1400 个截图和 JSON 的打包，两个协调者复核 zip（`p2.2/revision-4|5/coordinator-input/`）里装着 trace.zip 和 report.json；`p2.1/diagnostics/` 的两个 attachments.tar.gz 没有链接。')
    w('7. **逐用例 JSON**：被采用版本里 141 个运行目录的 `<项目>--<用例>--<附件>.json`（及打包它们的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`：每个文件的名字、字节数、SHA-256 和顶层标量字段（如 keyboard-window 样本的 target/sequence/mode/run/before/after/result）。逐目录核对过 README 已给出结论所用的数字（计数表、通过数、summary.json 链接，例如 p2-keyboard-window 的判定由 keyboard-window-summary.json 汇总），每个运行目录的 summary.json 和 report.summary.json 保留逐用例结果。README 单独链接的逐用例 JSON 保留。')
    w('8. **截图和差异图**：被采用版本的截图和差异图全部保留内容。同一任务目录里逐字节相同的副本（同提交参照与交付渲染一致、同一矩阵重复轮次）只留一份：文档链接到的副本，否则最近一次加入的副本。删掉的副本在 removed.tsv.gz 里指向保留的那份。不跨任务目录去重，每个任务目录仍有自己全部截图的一份。')
    w('9. **SHA256SUMS 类清单**：`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等保留原文件；它们核验的是提交 `7732f14f8` 里的文件，各 README 顶部的说明写明了这一点。')
    w('')
    w('## 哪一版被采用')
    w('')
    w('依据 Orbit 的证据判定记录：`task_evidence_list` 只有修订和摘要，判定在协调者会话的 `task_evidence_decide` 调用里，原始记录摘录在 [decisions.json](decisions.json)（判定 id、修订、摘要、时间）。每个任务以最后一次 CONFIRM 的修订为被采用版本。')
    w('')
    w('| 目录 | 任务 | 判定 | 被采用 |')
    w('| --- | --- | --- | --- |')
    for d, tid, name, verdicts, adopted in ADOPTED:
        w(f'| `{d}` | [{name}](orbit-task:{tid}) | {verdicts} | {adopted} |')
    w('')
    w('## 保留文件的理由分类')
    w('')
    w('瘦身后树里每个文件的理由（字节为 `git ls-tree -r -l` 大小）：')
    w('')
    w('| 类别 | 文件 | 字节 |')
    w('| --- | ---: | ---: |')
    for label, (cnt, size) in checks['keptCategories']:
        w(f'| {label} | {n(cnt)} | {n(size)} |')
    w(f'| 本目录 `evidence-slimming/` | {n(ad["evidence-slimming/"][1])} | {n(ad["evidence-slimming/"][0])} |')
    w('')
    w('## 受保护目录里仍带附件正文的报告')
    w('')
    wb = [r for r in protected_reports if r['attachmentsWithBody']]
    w(f'按协调者确认的口径（受保护目录优先），下面 {len(wb)} 份报告保留原样，共 {n(sum(r["bytes"] for r in wb))} 字节，其中附件正文 {n(sum(r["bodyBytes"] for r in wb))} 字节。'
      f'受保护目录里另有 {len(protected_reports) - len(wb)} 份不带附件正文的报告（{n(sum(r["bytes"] for r in protected_reports if not r["attachmentsWithBody"]))} 字节），全部清单见 [protected-reports.json](protected-reports.json)。')
    w('')
    w('| 文件 | 字节 | 带正文的附件 | 正文字节 |')
    w('| --- | ---: | ---: | ---: |')
    for r in wb:
        w(f'| `{r["path"]}` | {n(r["bytes"])} | {r["attachmentsWithBody"]} | {n(r["bodyBytes"])} |')
    w('')
    w('## 验证')
    w('')
    b, a = p0['before'], p0['after']
    w(f'**P0 浏览器回归，瘦身前后同一基础。** 两次都在本会话工作树里用普通入口 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` 跑完整矩阵，'
      '放在独立网络命名空间里（`unshare -n`），环境与 p0.2 记录逐字段一致（Playwright 1.63.0、Chromium 1243、WebKit 2359、字体文件哈希）。两次的 `src/` 树都是 '
      f'`{b["srcTree"]}`；区别只在证据目录。脚本见 [tools/p0-run.sh](tools/p0-run.sh)。')
    w('')
    w('| 运行 | 提交 | 证据目录树 | 通过 | 失败 | 跳过 | flaky | 期望截图组装 |')
    w('| --- | --- | --- | ---: | ---: | ---: | ---: | --- |')
    for k, label in (('before', '瘦身前'), ('after', '瘦身后')):
        m = p0[k]
        w(f'| {label} | `{m["head"][:9]}` | `{m["evidenceTree"][:9]}` | {m["stats"]["expected"]} | {m["stats"]["unexpected"]} | {m["stats"]["skipped"]} | {m["stats"]["flaky"]} | {m["expectedScreenshots"]} |')
    w('')
    w(f'两次的失败名单相同，都是 `pages.browser.mjs › profile` × 8 个项目：资料页的 `GET /api/auth/methods` 没有固定数据（`Every API call must have an explicit browser fixture`），是项目吸收 main `558a8ba1f` 带来的漂移，由 [P0 漂移登记（第 3 批）](orbit-task:34bkiemVmb1y5O0G52K6m) 处理，与瘦身无关。'
      f'逐用例对照（[p0/compare.json](p0/compare.json)）：{compare["tests"]} 个用例的状态和结果{"全部相同" if compare["identical"] else "有差异"}。'
      '每次运行的用例结果见 [p0/](p0/)（`*-tests.json`，以及去掉附件正文的 `*-report.summary.json`）。')
    w('')
    for c in checks['commands']:
        w(f'- **{c["name"]}**：`{c["command"]}` → {c["result"]}（{c["where"]}）。')
    w('')
    w(f'**抽样取回。** 从 `{BASE[:9]}` 用 `git show` 取回 {len(samples)} 个被删文件，覆盖 report.json、trace.zip、trace 附件、重复截图、被取代修订的截图、逐样本 JSON、逐用例 JSON 和打包的 attachments.tar.gz（[sample-retrieval.json](sample-retrieval.json)，脚本 [tools/sample-check.py](tools/sample-check.py)）：')
    w('')
    w('| 类别 | 文件 | SHA-256 | 核对 |')
    w('| --- | --- | --- | --- |')
    for s in samples:
        how = ['git blob 与 removed.tsv 一致']
        if 'matchesSummary' in s: how.append('与 attachments.summary.json 记录一致')
        if 'matchesKeptCopy' in s: how.append('与保留副本逐字节相同')
        if 'summaryEqualsOriginalWithoutBodies' in s: how.append('report.summary.json 等于原件去掉附件正文')
        if s['matchesTreeRecords']: how.append(f'与树里已有清单记录的哈希一致')
        w(f'| {s["label"]} | `{s["path"]}` | `{s["sha256"][:16]}…` | {"、".join(how)} |')
    w('')
    w('## 本目录文件')
    w('')
    w('- [removed.tsv.gz](removed.tsv.gz)：逐文件删除/替换清单。')
    w('- [sizes.json](sizes.json)：逐目录瘦身前后的字节数和文件数。')
    w('- [decisions.json](decisions.json)：用来判断被采用版本的证据判定记录。')
    w('- [protected-reports.json](protected-reports.json)：受保护目录里的全部报告及其附件正文体积。')
    w('- [sample-retrieval.json](sample-retrieval.json)：抽样取回的哈希核对。')
    w('- [p0/](p0/)：瘦身前后两次 P0 回归的元数据、逐用例结果、对照和去掉附件正文的报告。')
    w('- [checks/](checks/)：清单核对、构建和完整 Vitest 的命令输出。')
    w('- [tools/](tools/)：本次使用的脚本（分类、计划、执行、核对、生成本页）。')
    w('')
    w('本任务新增的证据只有本目录和上面列出的说明文件，合计远低于 30 MB。原始运行（含带正文的 P0 报告）留在会话目录，证据判定后清理。')
    return '\n'.join(L) + '\n'


# fixed point: the README's own size is part of the totals it prints
size = 0
for _ in range(6):
    subprocess.run(['git', 'add', '-A', '--', OUT], check=True)
    tree_id = subprocess.run(['git', 'write-tree'], capture_output=True, text=True, check=True).stdout.strip()
    after = tree(tree_id)
    self_size = sum(s for r, s in after.items() if r.startswith('evidence-slimming/'))
    text = render(after, self_size)
    open(OUT + 'README.md', 'w', encoding='utf-8').write(text)
    sizes = {'base': BASE, 'before': {k: {'bytes': v[0], 'files': v[1]} for k, v in by_dir(before).items()},
             'after': {k: {'bytes': v[0], 'files': v[1]} for k, v in by_dir(after).items()},
             'totals': {'before': {'bytes': sum(before.values()), 'files': len(before)}, 'after': {'bytes': sum(after.values()), 'files': len(after)}}}
    open(OUT + 'sizes.json', 'w').write(json.dumps(sizes, ensure_ascii=False, indent=1) + '\n')
    subprocess.run(['git', 'add', '-A', '--', OUT], check=True)
    tree_id = subprocess.run(['git', 'write-tree'], capture_output=True, text=True, check=True).stdout.strip()
    again = tree(tree_id)
    if again == after:
        print('stable: after', sum(after.values()), 'bytes', len(after), 'files; evidence-slimming', self_size)
        break
else:
    raise SystemExit('README size did not settle')
