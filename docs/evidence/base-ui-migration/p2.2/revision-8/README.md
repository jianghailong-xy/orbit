# P2.2 第8版：吸收当前 main，解除第4代 MAIN_SYNC

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/revision-8/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/revision-8 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：14 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 6 个 trace 压缩包；1499 个逐用例 JSON（含打包的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`（文件名、字节数、SHA-256 和顶层标量字段）；删除 398 张与本任务目录里保留副本逐字节相同的重复截图。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

本版服务于 [P2.2 菜单、浮层与选择控件](orbit-task:34Za394q2ZEgr7TKprjkF)，范围按任务评论 `34aUP2qm3rEeeDIYquPl2` 第1步及 2026-10-06 协调更新：只把项目 tip 和最新 main 吸收进源分支，不重做已验收的菜单/浮层/选择和通知实现。项目分支合入 main 的晋升冲突（待办 `34a2dUx2kUcBlw5CZ3rMU`，同为 ToastViewport.tsx/index.css）已挂在本任务上，由本次落地一并解决。验收条目 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

按账号所有者 2026-10-06 的决定，本轮由 Claude Opus 5.5 执行；第1–7版由 GPT-6-Astra 完成的实现、证据和独立判定继续有效。本轮没有修改任何组件、通知实现、fixture、测试断言、超时、重试或历史基线，也没有推送或改写 main/项目 ref。

## 来源、祖先与合并

| 角色 | 提交 |
| --- | --- |
| 本会话分支起点 / 项目 tip | `18e75cfe14d0a0858c9a46e514535439c9cdf9d8` |
| 快进接回的第7版已验收交付 | `45bb56928225bbe6d00800180ebcc73f26250fd4` |
| 开工时 origin/main，首次吸收 | `6cdca5a03d7baabe124c6ea8ae387c5269ce492e` |
| 首次吸收合并 | `38947755e48ac979362db36f82bfcf966b527a75`（树 `28ed8fc4c04ffb5d8f327e12295140bf3d992704`，与协调预演 merge-tree 相同） |
| 检查期间推进的 main，再次吸收 | `bf12315af31d56de71229b7ffa5ebfe2219efef5` |
| 最终被测合并 | `8a29e349324e7aaca83827a52148b540c118b992`（树 `2d6dfc9fe183a7780b4c454976e54332cf6cd946`，Web 树 `9aa3a0b96d7c1e3fd473995798774d4f20144885`） |

`git merge --ff-only 45bb56928` 后以 `--no-ff` 合入 `6cdca5a03`；提交前复核（[remote-refs.txt](remote-refs.txt)）发现 main 已到 `bf12315af`，按“有推进就再合一次”原样合入。最后一次复核时 main/项目 tip 仍为 `bf12315af`/`18e75cfe1`。最终提交的祖先包含两个 tip，以及已验收的 `d71afc686`、通知修复 `59c439e47` 和旧 main `53da29cc1`。之后只新增本目录和 `../checks/r8-*` 证据文件。

[合并审计](merge-audit.json)（`audit-merge.py`）对两次合并分别核对以下各项：
- 双亲。
- merge-tree 预览与提交树相同，无冲突，无手工解决。
- 两侧都改过的文件之外，每个变动 blob 都与某一父版本逐字节相同。
- 两侧都改过的文件里，每一侧的 +/− 变更行都原样保留。首次合并有3个这样的文件：`ToastViewport.tsx`（main 35 行 / 本线 98 行）、`index.css`（744 / 11）、`toast.test.tsx`（23 / 54）。第二次合并只有 `index.css`（239 / 11）。
- 16,844 份迁移历史证据的 mode/blob 不变。
- 104 份组件、fixture、通知、配置和锁文件输入中，首次合并只变了 `ToastViewport.tsx`（main 的 627989805），第二次一份未变。

根 package.json 只有上游版本号 0.1.210→0.1.213→0.1.215。锁文件与 src/web/package.json 未变，依赖按本树锁文件隔离安装。完整增量见 [upstream-delta.name-status.txt](upstream-delta.name-status.txt) 和 [upstream-web-delta.patch](upstream-web-delta.patch)。

### 语义核对

- **ToastViewport.tsx**：main 627989805 把失败卡（③ AttentionCard）的文案块改成进入会话的按钮（可访问名 `Open <会话标题>`），并去掉单独的 “Open session” 按钮。本线（P2.3/通知修复）改的是 portal 宿主、悬停驻留和退场焦点，与之不在同一 hunk。失败卡两侧都没有驻留处理；`.toast-copy--link` 样式在合并基点已存在（② 结果卡已在用）。通知专项只有一处提到 “Open session”，是对带 action 卡片的 `toHaveCount(0)`，两种实现下都成立，因此**不存在断言冲突**，也没有改断言。取舍：保留 main 的新行为（上游较新的产品决定，带单测），通知专项断言原样保留。
- **index.css**：[CSS 作用域审计](css-scope-audit.json)（`audit-css-scope.py`）显示，两次增量共 172+37 条变更选择器，没有一条能匹配 Orbit ui 组件、choices/toasts fixture 或 ToastViewport；也没有改动任何 CSS 自定义属性（设计变量）。
- **toast.test.tsx**：两侧新增用例都保留（基点13、本线+3、main+1，共17个 `it`），均通过。

## 最终组合验证（`8a29e3493`）

| 检查 | 结果 | 原件 |
| --- | --- | --- |
| 既定合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web` | 构建通过，320 文件 / 3987 测试通过（保留既有大 chunk 提示） | [记录](../checks/r8-final-build-test.json)、[日志](../checks/r8-final-build-test.txt) |
| choices / toasts / P0 发现列表 | 520 / 272 / 112；与首次合并的列表逐字节相同，测试身份与第6版一致；toasts 仅有第7版自身 +4 行引起的行号偏移；P0 不含专项 fixture | `../checks/r8-final-list-*` |
| choices 原入口（Dialog 内选择器、逐层 Esc/焦点/滚动锁），八环境 | 32/32 | [原件](final-choices-entry/summary.json) |
| 生产构建通知入口，八环境 | 8/8 | [原件](final-production-notifications/summary.json) |
| choices / overlays / toasts / toasts-tests 四套类型 | 通过 | [记录](../checks/r8-final-fixture-types.json) |
| main 新失败卡链接在 Dialog 所属通知内（点击/触摸、Tab+Enter），八环境 | 16/16 | [原件](final-attention-link/summary.json)，探针 `attention-link.browser.mjs` |

首次合并 `38947755e` 上已跑过：build/test（318/3974）、三套列表、choices 32/32、生产 8/8、四套类型、探针 16/16，见 `../checks/r8-*` 中不带 `final-` 的同名记录。另有完整 **toasts 272/272**（[原件](toasts-full/summary.json)，单次，10.2 分钟），用于确认 main 的失败卡改动与通知专项没有冲突。所有浏览器运行均为单 worker、retries=0，环境与 P0.2 [environment.json](../../p0.2/environment.json) 一致：Chromium1243/WebKit2359、Playwright1.63.0、字体、DPR1、UTC/en-US。

## 选择器全量矩阵：首轮 515/520 及归因

完整 choices 矩阵在 `38947755e` 上单次运行（24.9 分钟），结果 **515 通过 / 5 失败**。不把它写成全绿；原报告、截图、trace 和 error-context 全部保留在 [choices-full-first](choices-full-first/summary.json)，trace 摘要见 [choices-full-first-traces.json](choices-full-first-traces.json)。运行期间主机负载约 18（24 核，其他会话的 vLLM、vitest、postgres 容器在跑）。

| 失败 | 直接观察 | 归类 |
| --- | --- | --- |
| chromium-light-desktop 触摸/指针菜单；chromium-dark-desktop reduce 逐层退出；chromium-dark-phone tooltip 动效 | fixture 未挂载：分别有 13/11/12 个模块请求以 `net::ERR_NETWORK_CHANGED` 中止（主机网络接口变化时 Chromium 中止在途请求），theme/按钮从未出现 | 主机环境。与 r2 协调记录的签名相同；已验收树上同样出现过一次（见下） |
| webkit-light-desktop flipped search 动效 | 弹层已打开、动画名 `orbit-slide-down-in`、不透明度 1，但采集到的 animations 和 records 都为空 | 与 r2 记录的动效采集超时同类 |
| chromium-dark-desktop `select supports arrows, Enter, clear…` | 无网络错误；聚焦后三次按键在 15.6ms 内发出（用例本身不等待），Expiry 停在 `never`，帧中弹层已关闭 | 已验收 Select 的真实时序缺口，见下 |

**A/B 复跑**：同一命令（4 个项目 × 5 个失败用例 × 3 次）在合并树和已验收树 `45bb56928` 上都是 60/60（[合并树](rerun-merged/summary.json)、[已验收树](rerun-accepted/summary.json)）。

**Select 快速按键诊断**（仅在证据目录内的只读探针，不新增测试入口）：
- 方法：在 Orbit 字段、Orbit 样例和旧 AntD 样例上重复同样的无等待 ↓↓⏎，并在捕获阶段记录每个按键的落点。
- 规模：CPU 节流 1×/6×/20× 各 5 次（[原件](select-keys-throttle/summary.json)）；不节流时两棵树各 3×40 次（[合并树](select-keys-repeat-merged/summary.json)、[已验收树](select-keys-repeat-accepted/summary.json)）。汇总见 [select-keys-summary.json](select-keys-summary.json)。
- 结果：Orbit 在 189 个样本中丢失 2 次（节流探针 30、合并树 80、已验收树 79），两棵树各 1 次。这 2 次、且只有这 2 次，第二个 ↓ 落在 trigger 上：此时列表已显示，但焦点还没进入弹层，于是 ⏎ 重新选中了高亮的当前值。
- AntD 95 次 0 丢失。它的焦点始终留在输入框上，第二个 ↓ 在列表已显示时到达的有 54 次，照样正确移动。
- CPU 节流不能复现：页面执行变慢时，按键节奏也同样变慢。
- 因为 `Select.tsx`、Base UI 版本和锁文件在两棵树之间逐字节相同，这是已验收 P2.2 Select 在主线程繁忙时与 AntD 的键盘保真差异，不是本次吸收引入的。本轮范围是只吸收上游，不改组件；原用例及其断言保持不变，此项列为证据缺口并另提后续修复。

已验收树上的不节流探针为 119/120：未计入的 1 个样本又是 `ERR_NETWORK_CHANGED`（15 个模块中止），说明这类加载失败与合并无关。

## 复用与证据边界

- 组件保真（Menu、Popover、Tooltip、Select/Combobox/MultiSelect，以及手机附件菜单 42.4px 行高、17px 字号、26px 圆角）继续以已验收的 [r2](../revision-2/README.md)、[r5](../revision-5/README.md) 为证据；第7版确认入口和通知任务的独立 CONFIRM 按原归属沿用。它们的实现输入在本版逐字节保留。
- 完整 toasts 272 和完整 choices 520 都在 `38947755e` 上运行，没有在 `8a29e3493` 上重跑。两者之间这两个 fixture 的输入只差 `index.css`（37 条选择器，均不可达）、`@orbit/shared` 的 `codec.ts`（`PUBLIC_ID_FIELDS` 多一个字段）和 `api.ts` 新增函数。这一点由审计支撑，没有重新执行。
- 本轮 choices 全量没有单次全绿：首轮 515/520，A/B 复跑只覆盖失败用例。Select 快速按键缺口仍未修复。
- 历史失败全部保留，包括 r2 的 519/520、r3/r4 的 31/32 和早期诊断错误。本轮自己的探针设计错误也留在记录里：40 次样本放在一个用例里，超过 90 秒用例预算（`r8-select-keys-repeat-timeout`）；另有一次被我中止的运行，因为 CLI 的 reporter 覆盖会把 JSON 报告写到 stdout（`r8-select-keys-repeat-killed`）。
- 手机为 Linux 浏览器设备模拟；真机 iOS/软键盘、原生 IME、读屏和全站 P7 不由本轮确立。本交付不声称已落地；MAIN_SYNC 与晋升冲突待办由平台的实际落地关闭。

## 原件与复核

- 全部后台作业的命令、作业号、退出码和原始输出：`../checks/r8-*.json/.txt`，共 28 项。用 `record-checks.py` 写入，不覆盖既有文件；退出码取自 runner 的 bg_output。证据引用见 [tool-call-refs.json](tool-call-refs.json)。
- 复核脚本：`audit-merge.py`、`audit-css-scope.py`、`read-trace.py`、`summarize-select-keys.py`、`index-artifacts.py`。浏览器原件用仓库现有的 `src/web/ui-migration/collect-choice-evidence.mjs` 归档，每份附件带 SHA-256。
- [artifact-index.json](artifact-index.json) 覆盖本目录与 `../checks/r8-*` 全部文件；提交后可用 `python3 docs/evidence/base-ui-migration/p2.2/revision-8/index-artifacts.py --verify <commit>` 从 Git 对象逐个核对。
