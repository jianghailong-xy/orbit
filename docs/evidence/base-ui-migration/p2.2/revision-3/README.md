# P2.2 第3版：接入项目分支并解决测试配置冲突

> **证据瘦身（2026-10-07）**：完整原件见提交 `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`（瘦身前最后一个含完整文件的提交）。取回单个文件用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/p2.2/revision-3/<路径> > <文件>`，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/p2.2/revision-3 | tar -x -C <空目录>`。
>
> 本目录在瘦身中：4 份 Playwright 报告换成同目录的 `report.summary.json`，都只删附件正文；删除 1 个 trace 压缩包；删除被取代修订的 161 个原始运行文件（截图、逐用例 JSON、运行压缩包）。下文链接若指向这些文件，按上面的命令从该提交取回；读取它们的脚本要在取回的目录里运行。
>
> 第 3 版（判定 SEND_BACK）已被后续修订取代，被采用的是[第 8 版](../revision-8/README.md)。本版运行的截图、逐用例 JSON 已删除。
>
> 目录里的 SHA256SUMS 类清单（`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等）保留原文件，核验的是提交 `7732f14f8` 里的文件。做法、保留理由和逐文件删除清单见 [evidence-slimming](../../evidence-slimming/README.md)。

对应任务 [P2.2](orbit-task:34Za394q2ZEgr7TKprjkF) 和返工评论 `34a2L1x3W2iPgPRYaVAMn`。本轮保留已验收的菜单、浮层和选择组件，接入项目分支中的基线修复与 P2.3，只手工合并三处追加配置。项目验收 key `1BvO6hYrlFnU60JqxQPUHt`，原文：**P2：Orbit 自有弹层、选择及反馈组件保持现有键盘、焦点、通知和确认行为。**

| 固定版本 | 提交 |
| --- | --- |
| 原任务 tip，含三份 reviewer 日志补充 | `d5716beb168861834aed8ef22a99a5b966866322` |
| 实际接入的项目 tip | `18e75cfe14d0a0858c9a46e514535439c9cdf9d8` |
| merge-base | `67e62c0b4028eefe2c619dac80d3fac312cea601` |
| 两父合并及全部检查所用提交 | `e1eb1d3796a6086f413a6dd57bee228c2fa59c85` |
| 合并树 | `7097c8c0881a2433b13da3db287142a724340bc1` |

本说明、命令与附件随后作为独立证据提交；最终交付提交及树由任务评论和结构化证据记录。它相对上述固定提交只增加本轮证据，不改变被测源码、配置、锁文件或断言。没有改项目集成 ref，由平台处理后续落地。

| 文件 | 冲突处置 |
| --- | --- |
| `src/web/.gitignore` | 保留全部原规则，取双方并集，包含 `.choices-results/`、`.toasts-results/`、`.reviews-results/`。 |
| `src/web/package.json` | 同时保留 choices/toasts 的 test 与 pretest；其他 scripts、依赖和 metadata 不变。 |
| `src/web/ui-migration/playwright.config.mjs` | `testIgnore` 保留 foundation/controls/overlays/choices/toasts；仅此行改变，其他配置字节一致。专项配置仍以 `testIgnore: []` 和自己的 `testMatch` 收集测试。 |

`components/ui/README.md` 的双方追加说明自动合并，无手工覆盖。[审计脚本](audit-merge.py) 按 merge-base 与两个父版本逐个比较 Git mode/blob：6,032 个相同项、5,949 个项目侧独有变更、4,492 个任务侧独有变更均完整保留，只有三份配置及自动合并的 README 需要组合。[审计结果](merge-audit.json)、[相对任务父版本差异](diff-from-task-web.patch)、[相对项目父版本差异](diff-from-project-web.patch) 可直接复核。

双方运行时、断言及测试入口分别按原版本接入，没有额外编辑；包括项目已验收的 Overlay/通知集成与基线修复。原任务 6,697 份和项目父版本 7,909 份 `docs/evidence/` 文件逐字节保留（两边计数包含共有文件），P0 历史截图和失败标记未修改。r2 的全部 3,027 个索引项均核验为已跟踪且 SHA-256 匹配，包含 `d5716beb` 补入的三份日志。

按当前锁文件执行 `bash scripts/worktree-overlay.sh`，复用本工作树兼容的独立安装，生成本树 Prisma、构建本树 shared；未经过共享依赖链接安装。Node26.10.0、npm11.19.1，shared/Prisma/Vite 缓存归属见 [环境及来源](environment-and-provenance.json)。浏览器检查继续由原 environment.mjs 验证固定 OS、字体和 Chromium/WebKit；无重试配置、超时或截图容差改动。

| 组合树检查 | 结果 | 原始记录 |
| --- | --- | --- |
| `npm run build -w @orbit/web && npm run test -w @orbit/web` | exit 0；295 文件、3,661 用例通过；保留既有大 chunk 提示 | [命令/源码哈希](../checks/r3-build-and-test.json)、[完整输出](../checks/r3-build-and-test.txt) |
| choices `--list` | 520，4 文件，8 环境各65项 | [列表](../checks/r3-list-choices.txt) |
| toasts `--list` | 232，3 文件，8 环境各29项 | [列表](../checks/r3-list-toasts.txt) |
| P0 `--list` | 112，6 文件，8 环境各14项 | [列表](../checks/r3-list-p0.txt) |
| choices/toasts fixture、通知测试、评审卡片类型 | 四套检查均 exit 0 | [命令](../checks/r3-fixture-types.json)、[输出](../checks/r3-fixture-types.txt) |
| choices 嵌套入口 | 首轮31通过/1失败；原失败用例随后5/5 | [首轮报告](choices-entry-first/report.json)、[原样重复](choices-scroll-repeat/report.json)、[诊断](scroll-unlock-diagnostic.json) |
| toasts 入口 | 24/24，通过 Dialog 可访问性、异步确认、静止悬停跨拥有者 | [报告](toasts-entry/report.json)、[命令](../checks/r3-toasts-entry.json) |
| P0 生产通知入口 | 8/8，使用实际生产预览和固定接口数据 | [报告](production-entry/report.json)、[命令](../checks/r3-production-entry.json) |

[发现列表审计](discovery-audit.json) 保存每项 project/file/line/title 与源码 blob。choices 只收集四份 `choices*.browser.mjs`，toasts 只收集三份 `toasts*.browser.mjs`，P0 不含任何专项 fixture。P0 比原104项多出的8项全部来自项目父版本已经加入的 `feedback-production.browser.mjs`，原104项完整保留。`--list` 是收集验证，不是这三套矩阵全部运行通过的声明。脚本映射已按双方并集核验；入口实跑分别使用三个 npm script，包含其原 pretest。

choices 首轮覆盖正常/减少动效的三层 Dialog→Popover→Select 退出、Dialog 内组合输入法/外部关闭/子菜单 Esc/清除、Tab/主题/焦点，各八环境。唯一失败为 Chromium 亮色桌面、减少动效用例的最后一条即时滚动解锁断言（原文件第94行）。Dialog 不可见和触发器获焦断言都已通过；原 trace 的 `call@172` 返回仍锁定，紧随其后的5004.519快照中 BODY style 已为空。固定依赖的 `ScrollLocker.release` 用0ms Timeout 异步解锁，这与即时断言和清理之间的时序竞争相符。原命令只增加单项筛选及 `--repeat-each 5`，源码、断言、90秒超时、retries=0均不变，5次通过。没有确认该次调度顺序的独立因果根源，也没有把首轮改写成32/32。原失败 JSON、error-context、截图、trace 完整保留，重复报告使用独立目录。

本轮复用 [r2](../revision-2/README.md) 的外观、密度、动效、搜索/清除/禁用/选中/空态/分组及触摸/IME合成行为证据。r2 独立审查评论 `34a1pf5orvgxhcj0NbDXN` 的结论仍为 **完整520项中519通过/1动效采集超时，原失败用例随后5/5通过**，不是单次520全绿。独立归档 ZIP SHA-256 `a9650aafe26a94d46df16bc8632b4f685dd0aa5b3e7680bd177b913a8cbfd950` 本轮再次只读核对成功；评论与返工原文保存在 [coordinator-input](coordinator-input.json)。本轮没有机械重跑完整截图矩阵，没有覆盖任何旧证据。

`../checks/r3-*.json/.txt` 保留每条 argv、被测提交、源码哈希、完整输出及退出码。[tool-call-refs](tool-call-refs.json) 给出本任务会话的实际 CommandExecution 行引用；[artifact-index](artifact-index.json) 列出本轮原件，归档后从 Git 对象再验哈希。最初普通沙箱的 merge 因 worktree Git 元数据只读而在开始合并前被拒，随后经工具授权执行；这是命令环境限制，未改源码绕过。

边界：不声称首轮 choices 或历史 r2 单次全绿；本轮也没有重新验证完整 P0、全站 P7、真机 iOS/软键盘/原生 IME、读屏听测、系统剪贴板授权或真实后端。原有 P0 预期失败及跳过仍按原记录。新的交付仍需独立 EVIDENCE_JUDGMENT 和平台落地回执，不直接写 DONE、不部署或发布。若需撤回本轮配置整合，可评估合并提交对两个父版本的差异，避免撤销已验收的 P2.3；不要覆盖项目分支或历史证据。
