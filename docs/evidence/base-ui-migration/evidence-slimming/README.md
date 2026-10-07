# 证据瘦身：从树里移除原始 Playwright 产物

服务于 [证据瘦身：从树里移除原始 Playwright 产物](orbit-task:34bmAdTEaU6RjOFacPare)（项目验收 key `6QXvm6WUbzep2HRIVGXjvu`）。起点是项目分支 tip `7732f14f82d4e6b4406d7d164c4b672f63aa0f56`，它就是瘦身前最后一个含完整文件的提交：本次删掉或改写的每个文件都能用 `git show 7732f14f82d4e6b4406d7d164c4b672f63aa0f56:docs/evidence/base-ui-migration/<路径>` 取回，整个目录用 `git archive 7732f14f82d4e6b4406d7d164c4b672f63aa0f56 docs/evidence/base-ui-migration/<目录> | tar -x -C <空目录>`。历史提交没有改动，改动只在 `docs/evidence/base-ui-migration/` 内。

## 结果

- 证据目录（`git ls-tree -r -l` 的字节求和）：**1,837,261,010 字节 / 46,847 个文件 → 410,026,742 字节 / 9,743 个文件**，含本目录（1,620,355 字节）。
- 树里没有 trace 压缩包。受保护目录以外没有 Playwright 报告原件：303 份报告都换成了同目录的 `report.summary.json`（或 `<原名>.summary.json`），逐份核对过与原件去掉 `attachments[].body` 后完全相同，共保留 28,344 条用例结果、删掉 47,417 个附件正文。
- p0.2、p0-drift、p0-drift-2、p3.2-accepted（p0-drift-3、inventory-delta 尚未落地）和根目录清单文件逐字节未改；src/web 代码读取的证据文件和证据目录以外 Markdown 链接到的文件都还在（见「验证」）。
- [.gitignore](../.gitignore) 忽略 `trace.zip`、`*-trace.zip` 和 `report.json`，防止再提交。

| 目录 | 瘦身前 字节 | 文件 | 瘦身后 字节 | 文件 | 说明 |
| --- | ---: | ---: | ---: | ---: | --- |
| `p0-drift/` | 35,937,099 | 401 | 35,937,099 | 401 | 受保护，未改 |
| `p0-drift-2/` | 10,210,245 | 416 | 10,210,245 | 416 | 受保护，未改 |
| `p0.2/` | 33,702,983 | 554 | 33,702,983 | 554 | 受保护，未改 |
| `p1.1/` | 14,509,105 | 352 | 1,748,583 | 78 |  |
| `p1.1-integration/` | 5,174,593 | 48 | 5,174,593 | 48 | 未改 |
| `p1.2/` | 32,377,641 | 313 | 5,177,694 | 106 |  |
| `p2-integration-cards/` | 4,149,386 | 56 | 2,530,220 | 50 |  |
| `p2-keyboard-window/` | 326,352,442 | 18,359 | 77,814,504 | 2,087 |  |
| `p2-promotion-toast/` | 232,316,457 | 2,701 | 18,206,389 | 494 |  |
| `p2-select-keys/` | 40,938,323 | 3,375 | 13,593,834 | 501 |  |
| `p2.1/` | 55,859,078 | 863 | 6,257,067 | 270 |  |
| `p2.2/` | 386,030,874 | 9,056 | 43,791,988 | 1,404 |  |
| `p2.3/` | 360,401,647 | 5,620 | 26,012,950 | 825 |  |
| `p2.3-b1/` | 55,095,812 | 1,370 | 25,240,150 | 799 |  |
| `p3.1/` | 25,023,113 | 878 | 4,165,716 | 338 |  |
| `p3.2/` | 204,453,017 | 2,233 | 84,112,941 | 1,089 |  |
| `p3.2-accepted/` | 13,987,238 | 246 | 13,987,238 | 246 | 受保护，未改 |
| `evidence-slimming/` | 0 | 0 | 1,620,355 | 30 | 本任务新增 |
| `(根目录文件)` | 741,957 | 6 | 742,193 | 7 | 6 个清单文件未改，新增 .gitignore |
| **合计** | **1,837,261,010** | **46,847** | **410,026,742** | **9,743** | |

逐目录数字也在 [sizes.json](sizes.json)。逐文件的删除/替换清单在 [removed.tsv.gz](removed.tsv.gz)：路径、字节数、起点提交里的 git blob、处理方式，以及替换文件或保留副本的路径（`zcat removed.tsv.gz | grep <路径>`）。

## 提交

删除和改写各在独立提交里，提交信息写明删掉的体积：

| 提交 | 内容 | 删除 | 新增 |
| --- | --- | ---: | ---: |
| `ad71bbaa5` | report.json（及 7 份带附件正文的其他文件名报告、1 份 report.json.gz）换成同目录的 report.summary.json，只删附件正文 | 798,124,535 字节 / 303 个 | 41,885,192 字节 / 303 个 |
| `98f5ea38c` | 删除 trace 压缩包 | 187,699,432 字节 / 257 个 | 0 字节 / 0 个 |
| `2d351e482` | 删除被取代修订（P2.1 第 1 版、P2.2 第 1–7 版、P2.3 第 1–2 版）的截图、逐用例 JSON 和运行压缩包 | 182,224,097 字节 / 10,348 个 | 0 字节 / 0 个 |
| `394a25c85` | 被采用版本里的逐用例 JSON 换成所在目录的 attachments.summary.json | 113,998,977 字节 / 19,681 个 | 9,589,204 字节 / 141 个 |
| `ed5ae324c` | 删除同一任务目录里逐字节相同的重复截图 | 198,313,166 字节 / 6,991 个 | 0 字节 / 0 个 |
| `9014a478d` | 22 份 README 顶部加瘦身说明，p2-integration-cards 新建 README，新建 `.gitignore` | 0 | 说明 +31,188 字节 |
| （本提交） | 本目录 | 0 | 见上表 |

## 规则

1. **受保护，逐字节不动**：`p0.2/`、`p0-drift/`、`p0-drift-2/`、所有 `*-accepted/`（现有 `p3.2-accepted/`）、根目录文件（ownership.json、audit-baseline.json、css-ownership.json、component-contracts.md、routes-and-tests.md、README.md）。`p0-drift-3/`、`inventory-delta/` 在起点还没落地。
2. **代码读取的文件**：动手前用 `git grep` 核对了 src/web 和 scripts 里读取证据目录的代码。src/web/ui-migration 的 expected-screenshots.mjs、environment.mjs、composer-checks.mjs、controls.browser.mjs、foundation.browser.mjs、collect-evidence.mjs 只读 p0.2、p0-drift 和 p0-drift-2 下的文件，另外 expected-screenshots.mjs 要求两份判定文档存在：`p2.3-b1/README.md`、`p3.2/README.md`（都保留）。src/web/scripts/verify-antd-inventory.mjs 只读根目录清单文件。scripts/ 里没有读这个目录的代码（只读 docs/evidence/deepseek-harness）。
3. **证据目录以外的 Markdown 链接**：全仓库 Markdown 只链接到 6 个文件，都是 README（`README.md`、`p0.2/`、`p1.1/`、`p1.2/`、`p2.2/`、`p3.1/` 的 README），都保留。
4. **Playwright 报告**：`report.json`（及 `report.json.gz`、带附件正文的其他文件名报告）换成同目录的 `report.summary.json`：原报告只删 `attachments[].body`，用例标题、项目、状态、耗时、重试、错误、stdout/stderr、步骤和附件路径全部保留。原文件删除。
5. **trace 压缩包**：全部删除（`trace.zip`、`<项目>--<用例>--trace.zip` 及其他 `*trace.zip`）。
6. **被取代、没被采用的修订**：按下表的判定记录，删除截图、逐用例 JSON 和运行压缩包；README、检查结果文本（.md/.txt）、汇总/索引/审计 JSON、脚本、补丁和日志保留。有文档单独链接的 27 个小文件（截图和 JSON，共 0.7 MB）保留，链接不断。运行压缩包即使有文档链接也按原始运行输出删除：`p2.2/diagnostics/history.tar.gz` 是第 1 版诊断运行约 1400 个截图和 JSON 的打包，两个协调者复核 zip（`p2.2/revision-4|5/coordinator-input/`）里装着 trace.zip 和 report.json；`p2.1/diagnostics/` 的两个 attachments.tar.gz 没有链接。
7. **逐用例 JSON**：被采用版本里 141 个运行目录的 `<项目>--<用例>--<附件>.json`（及打包它们的 attachments.tar.gz）换成所在目录的 `attachments.summary.json`：每个文件的名字、字节数、SHA-256 和顶层标量字段（如 keyboard-window 样本的 target/sequence/mode/run/before/after/result）。逐目录核对过 README 已给出结论所用的数字（计数表、通过数、summary.json 链接，例如 p2-keyboard-window 的判定由 keyboard-window-summary.json 汇总），每个运行目录的 summary.json 和 report.summary.json 保留逐用例结果。README 单独链接的逐用例 JSON 保留。
8. **截图和差异图**：被采用版本的截图和差异图全部保留内容。同一任务目录里逐字节相同的副本（同提交参照与交付渲染一致、同一矩阵重复轮次）只留一份：文档链接到的副本，否则最近一次加入的副本。删掉的副本在 removed.tsv.gz 里指向保留的那份。不跨任务目录去重，每个任务目录仍有自己全部截图的一份。
9. **SHA256SUMS 类清单**：`*.sha256`、`artifact-index*.json`、`manifest.json`、各运行 `summary.json` 里的附件哈希等保留原文件；它们核验的是提交 `7732f14f8` 里的文件，各 README 顶部的说明写明了这一点。

## 哪一版被采用

依据 Orbit 的证据判定记录：`task_evidence_list` 只有修订和摘要，判定在协调者会话的 `task_evidence_decide` 调用里，原始记录摘录在 [decisions.json](decisions.json)（判定 id、修订、摘要、时间）。每个任务以最后一次 CONFIRM 的修订为被采用版本。

| 目录 | 任务 | 判定 | 被采用 |
| --- | --- | --- | --- |
| `p1.1/` | [P1.1](orbit-task:34Za38yCyTgCjo2t8Bmi4) | 第 1 版 CONFIRM | 第 1 版 |
| `p1.1-integration/` | [P1.1 集成依赖修复](orbit-task:34ZnH5biBaQVTpb6qKIh5) | 第 1 版 CONFIRM | 第 1 版（本次未改动） |
| `p1.2/` | [P1.2](orbit-task:34Za391ERoVi0sWSzRhvD) | 第 1 版 CONFIRM | 第 1 版 |
| `p2.1/` | [P2.1](orbit-task:34Za393HPMLVyuXAdfv3j) | 第 1 版 SEND_BACK；第 2 版 CONFIRM | 第 2 版 `revision-2/` |
| `p2.2/` | [P2.2](orbit-task:34Za394q2ZEgr7TKprjkF) | 第 1、3、4、6 版 SEND_BACK；第 2、5、7 版 CONFIRM 后被后续修订取代；第 8 版 CONFIRM | 第 8 版 `revision-8/` |
| `p2.3/` | [P2.3](orbit-task:34Za3974yqnhjQsRBl0R3) | 第 1、2 版 SEND_BACK；第 3 版 CONFIRM | 第 3 版 `revision-3/` |
| `p2.3-b1/` | [P2.3 回归修复 B1](orbit-task:34bQk0jlytjFYyi4OgLMK) | 第 1 版 CONFIRM | 第 1 版 |
| `p2-integration-cards/` | [紧凑决策卡片集成修复](orbit-task:34a0sy3NmYy7MLbOcqhkW) | 第 1 版 CONFIRM | 第 1 版 |
| `p2-keyboard-window/` | [P2 跟进（Menu/Select 窗口按键）](orbit-task:34b7qz5n4yA7s4fJmHNDn) | 第 1 版 CONFIRM | 第 1 版 |
| `p2-promotion-toast/` | [P2 晋升冲突修复](orbit-task:34a3I43L28Ca0NpMy6Fe8) | 第 1 版 CONFIRM | 第 1 版 |
| `p2-select-keys/` | [P2 修复（Select 快速连按）](orbit-task:34b4miWykA9R4izIml42v) | 第 1 版 CONFIRM | 第 1 版 |
| `p3.1/` | [P3.1](orbit-task:34Za398jkGI2ymxpFlbf2) | 第 1 版 CONFIRM | 第 1 版 |
| `p3.2/` | [P3.2](orbit-task:34Za39ACSBoCkYKc80Md8) | 第 1 版 CONFIRM；第 2 版（落地冲突返工，沿用第 1 版部分运行）CONFIRM | 第 2 版（含其沿用的第 1 版运行） |

## 保留文件的理由分类

瘦身后树里每个文件的理由（字节为 `git ls-tree -r -l` 大小）：

| 类别 | 文件 | 字节 |
| --- | ---: | ---: |
| 被采用版本的截图和差异图（每个任务目录每张一份） | 4,662 | 160,909,284 |
| 受保护目录与根目录清单（逐字节未改） | 1,623 | 94,579,522 |
| 汇总、索引、审计 JSON（含 artifact-index、manifest 等 SHA256SUMS 类清单） | 1,518 | 49,317,730 |
| report.summary.json（Playwright 报告去掉附件正文） | 303 | 41,885,192 |
| README、说明文档、检查结果文本（.md/.txt，含 22 份加了说明的 README） | 1,193 | 39,495,167 |
| attachments.summary.json（逐用例 JSON 汇总） | 141 | 9,589,204 |
| 脚本、补丁、日志、样式和 .sha256 清单 | 240 | 6,715,087 |
| 压缩的依赖安装快照与合并检查日志（README 引用） | 4 | 5,190,681 |
| 被取代修订里文档单独链接的截图和 JSON | 27 | 722,869 |
| 新增 .gitignore 和 p2-integration-cards/README.md | 2 | 1,651 |
| 本目录 `evidence-slimming/` | 30 | 1,620,355 |

## 受保护目录里仍带附件正文的报告

按协调者确认的口径（受保护目录优先），下面 30 份报告保留原样，共 22,167,646 字节，其中附件正文 20,264,748 字节。受保护目录里另有 38 份不带附件正文的报告（427,798 字节），全部清单见 [protected-reports.json](protected-reports.json)。

| 文件 | 字节 | 带正文的附件 | 正文字节 |
| --- | ---: | ---: | ---: |
| `p0-drift-2/attribution/runs/diag-d233a6cd0/report.json.gz` | 12,359 | 8 | 90,532 |
| `p0-drift-2/attribution/runs/diag-xfix-d233a6cd0/report.json.gz` | 11,449 | 8 | 88,712 |
| `p0-drift-2/attribution/runs/diag-xfix-e6786d077/report.json.gz` | 12,092 | 8 | 88,584 |
| `p0-drift-2/checks/delivery-round-1/report.json.gz` | 616,402 | 32 | 833,016 |
| `p0-drift-2/checks/delivery-round-2/report.json.gz` | 616,418 | 32 | 833,016 |
| `p0-drift-2/checks/final-round-1/report.json.gz` | 615,784 | 32 | 832,024 |
| `p0-drift-2/checks/final-round-2/report.json.gz` | 615,823 | 32 | 832,024 |
| `p0-drift-2/checks/negative-control-desktop/report.json.gz` | 618,610 | 32 | 833,016 |
| `p0-drift-2/checks/negative-control/report.json.gz` | 619,875 | 32 | 833,016 |
| `p0-drift-2/checks/tip-start/report.json.gz` | 620,386 | 32 | 832,024 |
| `p0-drift/b-class/demo-b1-neutralized/report.json` | 1,104,726 | 32 | 832,020 |
| `p0-drift/b-class/neutralized-final/report.json` | 1,102,250 | 32 | 832,020 |
| `p0-drift/checks/final-round-1/report.json` | 1,179,430 | 32 | 832,024 |
| `p0-drift/checks/final-round-2/report.json` | 1,179,435 | 32 | 832,024 |
| `p0-drift/checks/tip-regression-1/report.json` | 1,179,431 | 32 | 832,024 |
| `p0-drift/checks/tip-regression-2/report.json` | 1,179,425 | 32 | 832,024 |
| `p0-drift/negative-control/accepted/run-beyond-and-unregistered/report.json` | 1,306,172 | 32 | 832,024 |
| `p0-drift/negative-control/accepted/run-registered/report.json` | 1,169,744 | 32 | 832,024 |
| `p0-drift/negative-control/accepted/run-unregistered/report.json` | 1,237,556 | 32 | 832,024 |
| `p0-drift/negative-control/main-drift-1px/report.json` | 1,210,390 | 32 | 832,024 |
| `p0-drift/negative-control/run/report.json` | 1,212,119 | 32 | 832,024 |
| `p0.2/baseline-run/report.json` | 266,222 | 16 | 6,144 |
| `p0.2/diagnostics/clock-shim-run/report.json` | 266,222 | 16 | 6,144 |
| `p0.2/diagnostics/initial-browser-report.json` | 522,582 | 16 | 6,144 |
| `p3.2-accepted/checks/final-round-1/report.json.gz` | 613,826 | 32 | 833,016 |
| `p3.2-accepted/checks/final-round-2/report.json.gz` | 613,830 | 32 | 833,016 |
| `p3.2-accepted/checks/tip-start/report.json.gz` | 616,440 | 32 | 833,016 |
| `p3.2-accepted/negative-control/more-menu/report.json.gz` | 616,082 | 32 | 833,016 |
| `p3.2-accepted/negative-control/share-access/report.json.gz` | 616,038 | 32 | 833,016 |
| `p3.2-accepted/negative-control/share-close/report.json.gz` | 616,528 | 32 | 833,016 |

## 验证

**P0 浏览器回归，瘦身前后同一基础。** 两次都在本会话工作树里用普通入口 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web` 跑完整矩阵，放在独立网络命名空间里（`unshare -n`），环境与 p0.2 记录逐字段一致（Playwright 1.63.0、Chromium 1243、WebKit 2359、字体文件哈希）。两次的 `src/` 树都是 `4dddb863dc9db4de35ef536aaed58c5010895486`；区别只在证据目录。脚本见 [tools/p0-run.sh](tools/p0-run.sh)。

| 运行 | 提交 | 证据目录树 | 通过 | 失败 | 跳过 | flaky | 期望截图组装 |
| --- | --- | --- | ---: | ---: | ---: | ---: | --- |
| 瘦身前 | `7732f14f8` | `e00850d3e` | 93 | 8 | 11 | 0 | 88 P0.2 originals, 152 main drift references, 12 accepted migration differences |
| 瘦身后 | `9014a478d` | `9374ddc0b` | 93 | 8 | 11 | 0 | 88 P0.2 originals, 152 main drift references, 12 accepted migration differences |

两次的失败名单相同，都是 `pages.browser.mjs › profile` × 8 个项目：资料页的 `GET /api/auth/methods` 没有固定数据（`Every API call must have an explicit browser fixture`），是项目吸收 main `558a8ba1f` 带来的漂移，由 [P0 漂移登记（第 3 批）](orbit-task:34bkiemVmb1y5O0G52K6m) 处理，与瘦身无关。逐用例对照（[p0/compare.json](p0/compare.json)）：112 个用例的状态和结果全部相同。每次运行的用例结果见 [p0/](p0/)（`*-tests.json`，以及去掉附件正文的 `*-report.summary.json`）。

- **清单核对脚本**：`node src/web/scripts/verify-antd-inventory.mjs` → 退出 0：Inventory coverage passed: 149 source owners, 37 import contracts, 287 tests, 187 CSS hits on 182 lines; source reproduction not requested.（提交 `9014a478d`，输出 [checks/inventory.txt](checks/inventory.txt)）。
- **项目合并检查**：`npm run build -w @orbit/web && npm run test -w @orbit/web` → 构建通过；Vitest 344/344 个测试文件、4379/4379 个用例全部通过（提交 `9014a478d`，输出 [checks/build-test.txt](checks/build-test.txt)）。

**抽样取回。** 从 `7732f14f8` 用 `git show` 取回 10 个被删文件，覆盖 report.json、trace.zip、trace 附件、重复截图、被取代修订的截图、逐样本 JSON、逐用例 JSON 和打包的 attachments.tar.gz（[sample-retrieval.json](sample-retrieval.json)，脚本 [tools/sample-check.py](tools/sample-check.py)）：

| 类别 | 文件 | SHA-256 | 核对 |
| --- | --- | --- | --- |
| report.json (large, with bodies) | `p2-promotion-toast/final-notifications-raw/report.json` | `d97f7aefd5c0abd6…` | git blob 与 removed.tsv 一致、report.summary.json 等于原件去掉附件正文 |
| report.json | `p2-promotion-toast/delivery-notifications-raw/report.json` | `0c672758f87a759f…` | git blob 与 removed.tsv 一致、report.summary.json 等于原件去掉附件正文 |
| trace.zip | `p2-promotion-toast/exit-host-diagnostic-raw/toasts-promotion.browser.m-cbd2c-s-with-no-preference-motion-chromium-light-desktop/trace.zip` | `cf351b55fe0484ea…` | git blob 与 removed.tsv 一致 |
| trace attachment | `p2-keyboard-window/regression-choices-full-delivered-second/chromium-dark-desktop--email-tags-support-controlled-typing-separators-composition-Enter-blur-and-deletion--trace.zip` | `dd9541ee72d0c43d…` | git blob 与 removed.tsv 一致、与树里已有清单记录的哈希一致 |
| screenshot (duplicate copy) | `p2.2/revision-8/choices-full-first/webkit-light-desktop--tags-chip-appearance-matches-current-labels-and-email-fields--orbit-tags-disabled.png` | `da398dfad6b7949e…` | git blob 与 removed.tsv 一致、与保留副本逐字节相同、与树里已有清单记录的哈希一致 |
| screenshot (superseded revision) | `p2.3/revision-2/static-raster-after/chromium-dark-desktop--notification-pixels-stay-intact-through-Confirmation-opening-and-closing--opening-notification.png` | `4da7466a09258dcb…` | git blob 与 removed.tsv 一致、与树里已有清单记录的哈希一致 |
| per-sample JSON (p2-keyboard-window) | `p2-keyboard-window/fix-select-after-down-end-enter/chromium-dark-desktop--orbit-sample-select-down-end-enter-burst-sample-17--keyboard-window.json` | `1a5f469db34cf799…` | git blob 与 removed.tsv 一致、与 attachments.summary.json 记录一致、与树里已有清单记录的哈希一致 |
| per-test JSON | `p2-keyboard-window/regression-repeat-motion-flipped-attachment-desktop/webkit-light-desktop--normal-flipped-entrance-and-exit-motion-matches-attachment--repeat-8--motion.json` | `f0a6b1e07e9d036c…` | git blob 与 removed.tsv 一致、与 attachments.summary.json 记录一致、与树里已有清单记录的哈希一致 |
| archive of per-test JSON | `p2-keyboard-window/fix-pilot-run-before/attachments.tar.gz` | `0868603c915ffee4…` | git blob 与 removed.tsv 一致、与 attachments.summary.json 记录一致、与树里已有清单记录的哈希一致 |
| per-test JSON (superseded revision) | `p2.2/revision-5/final-entry/webkit-light-desktop--no-preference-Dialog-Popover-Select-exits-restore-one-layer-at-a-time--scroll-unlock.json` | `fd161a6d37a02570…` | git blob 与 removed.tsv 一致、与树里已有清单记录的哈希一致 |

## 本目录文件

- [removed.tsv.gz](removed.tsv.gz)：逐文件删除/替换清单。
- [sizes.json](sizes.json)：逐目录瘦身前后的字节数和文件数。
- [decisions.json](decisions.json)：用来判断被采用版本的证据判定记录。
- [protected-reports.json](protected-reports.json)：受保护目录里的全部报告及其附件正文体积。
- [sample-retrieval.json](sample-retrieval.json)：抽样取回的哈希核对。
- [p0/](p0/)：瘦身前后两次 P0 回归的元数据、逐用例结果、对照和去掉附件正文的报告。
- [checks/](checks/)：清单核对、构建和完整 Vitest 的命令输出。
- [tools/](tools/)：本次使用的脚本（分类、计划、执行、核对、生成本页）。

本任务新增的证据只有本目录和上面列出的说明文件，合计远低于 30 MB。原始运行（含带正文的 P0 报告）留在会话目录，证据判定后清理。
