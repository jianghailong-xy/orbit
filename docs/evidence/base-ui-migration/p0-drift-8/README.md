# P0 漂移登记（第 8 批）：设置页 Session recaps、任务详情 Engine 行与回合头 Worked for

本目录服务于任务 [P0 漂移登记（第 8 批）：会话摘要开关带来的 settings 截图漂移](orbit-task:34dI9lY63LC7ZEZHbJ4bG)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。**

按 [p0-drift README](../p0-drift/README.md)「维护规则」main 漂移参考第 3 条，这是协调者另建的「P0 漂移登记」任务。起因是 main 的 0418 会话摘要改动让设置页多出 Session recaps 一行，标准 P0 的 8 张 settings 截图失败（任务 [34coPBqt8gi229cVNds0E](orbit-task:34coPBqt8gi229cVNds0E) 测得）；协调者的补充线索（P5.2 的观察）还有会话页的 Worked for 一行和任务详情的 Engine 一行。规则和两个登记层都在 p0-drift 目录；本目录是这一批的失败清单、逐张归因、登记清单（含已接受层的处理）、验证和精简后的原始记录。

## 结论

| 项目 | 结果 |
| --- | --- |
| 开工时 | 项目 tip `951882866` 已由 origin/main `bcf00ab95`（Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main）晋升，两者的树相同（`fdf88a835`）。`git merge-tree --write-tree` 干跑没有冲突，`WikiSettingsPage.tsx` 不冲突，晋升同步已落地；按「跟上 main」快进到 `bcf00ab95`。main 和项目线的两个登记层都没有提到这次改动。 |
| 开工时的失败 | 新基础 `bcf00ab95` 上 P0 原命令（作业 `bgj_2ebf26dbe2da`）：112 个测试，73 通过、11 个已记录的跳过、**28 失败**：task、settings、session 各 8 个项目，断点巡检 4 个桌面项目，与协调者的线索一致。 |
| 完整失败面 | update 模式截全 252 张，对照当前期望：**120 张**不通过比较器（任务详情 48、设置页 16、会话页 56）；另 9 张低于阈值：6 张 wiki-new-entry 是 P4.4 自己记录过的迁移差异，3 张是此前已记录的低于阈值差异。 |
| 归因 | 120 张全部逐张归因到单个 main 提交，每层都有同环境运行（17 次完整矩阵），**0 张归因不到 main**：<br>• **A15** main `46e28aaa3`（Merge refs/heads/project/34d0oH4R6LErqqsox7wYv into refs/heads/main），合入 `83671b995`（feat(clients): the session list shows the server's recap, behind one account switch）：设置页 16 张。项目线 `cb35d126a` 吸收它（两者树相同）。<br>• **A16** main `e69765706`（Merge refs/heads/project/34ccMg4EoSorpVooMC4kg into refs/heads/main），合入 T7 的 `3a3c58c1f`（feat(web): sessions, tasks and workspaces pick the engine, then a provider it runs）：任务详情与 599/601px 对话框 48 张。项目线 `2fcd654d8` 吸收它。<br>• **A17** main `d2e295917`（feat(web): a worked-for row at the head of every turn, over its own output）：会话页 56 张。项目线 `d354b64c5` 吸收它。<br>区间里的迁移提交（P4.4，tasks 工具栏，Select/Close）没有改变这 120 张。 |
| 登记 | 一个登记提交 `4882b380e`，只改 `p0-drift/reference/`、`p0-drift/accepted/` 和 p0-drift README 的两个清单（154 个文件），可单独回退。main 漂移层 206 条中替换 89 条（A15 12、A16 25、A17 52），没有新登记。期望组装由 `44 / 183 / 25` 变为 **`44 P0.2 originals, 173 main drift references, 35 accepted migration differences`**。 |
| 已接受层 | 按已接受层第 6 条第二种情况（X 的树已含该页面的迁移代码）：**不更新 main 漂移层**，before 取 X 的 first-parent 前驱树，after 取 X 的树，**引用原判定**（P3.2 第 2 版、WebKit 滚动锁第 1 版），旧条目移入 `previous`：重登 21 条（task-share-dialog 8、task-action-menu 6、WebKit 的 settings-saved 3、WebKit 的 notification-error 4）。另有 10 张此前没有条目、但带着已 CONFIRM 的低于阈值迁移差异的截图，按第 7 批的做法首次登记，没有放进 main 漂移层（见「缺口与边界」）。 |
| 迁移代码 | 三棵生成树都含已晋升的迁移代码；前驱树上登记的截图对照当前期望都通过比较器，前驱到 X 只改设置卡片列、任务面板 Details 区、会话页消息列，所以登记的只有 main 改动；没有把迁移改动登记为漂移。 |
| 两轮完整 P0 | 登记提交 `4882b380e` 上连续两轮 P0 原命令（作业 `bgj_426b7f01bee4`）：每轮 112 个测试，**101 通过、11 个已记录的跳过、0 失败、0 flaky**，退出码 0，两轮逐项一致；没有 `unhandled`，没有页面异常。 |
| 负对照 | 本批新登记的三行各右移 1 像素（临时提交，不交付）：P0 原命令 **28 个失败，全部停在本批登记的截图上**；update 模式下本批登记的 120 张里 112 张检出（另 8 张是 task-share-dialog，对话框盖住了那一行），其余 132 张没有一张失败。 |
| 合并检查 | `npm run build -w @orbit/web && npm run test -w @orbit/web`（作业 `bgj_d14ce8c56f8b`，在 `4882b380e` 上）退出码 0：构建成功；Vitest **390 个文件、5117 个用例全部通过**。 |
| 最新 main | 交证据前 origin/main 又前进到 `d0e925f92`（项目线再次晋升，带进 P5.2）：干跑无冲突，main 没有改本批的文件；临时合并树上标准 P0 101 通过、11 跳过、0 失败（作业 `bgj_401393e81090`），`--check-owners` 0 未归属。 |
| 不变的部分 | P0.2 原图、原断言、known-failures、比较选项与容差、场景、固定数据、产品代码和 shared 都没有改（核对命令见「不变的部分」）。 |

## 执行经过

- **会话**：`1GSZWdCpULWB9D2dbYpioo`，2026-10-10 04:45 UTC 起，由 Claude Opus 5.5 执行。开工读了作业指导「P0 期望截图分三层」「跟上 main」「共享主机磁盘」「证据体积」，p0-drift README 的维护规则（main 漂移第 3–7 条，已接受层第 5、6 条），第 7 批先例和协调者在任务上的线索。
- **起点**：项目分支 `refs/heads/project/34ZZeq0e3IR65GVm2kAs7` 的 tip 是 `951882866`（Merge refs/heads/orbit/p2-select-close-antd-d927a5）。`git merge-base --is-ancestor` 表明它已在 origin/main 里：`bcf00ab95` 把它晋升进 main，两者的树逐字节相同。按「跟上 main」，本批分支直接快进到 `bcf00ab95`。任务说明里担心的 `WikiSettingsPage.tsx` 冲突已不存在（干跑 `git merge-tree --write-tree 951882866 origin/main` 退出码 0）。
- **磁盘与内存**：根分区开工时约 8.6 GB；检出、依赖、构建树、TMPDIR 和全部运行原件都放在 `/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG/`。每个浏览器运行和构建都包在 6G 的 cgroup 里（`systemd-run --scope -p MemoryMax=6G`，`oom_score_adj 500`，[cg.sh](tools/cg.sh)），每次构建和运行前等 MemAvailable ≥ 2000 MB（[lane.sh](tools/lane.sh)）。主机负载常在 17–43、可用内存 1.7–7 GB；最多同时两条浏览器队列。没有 OOM。
- **main 前进**：登记之前 origin/main 前进到 `cc16cb214`（`bcf00ab95` 之后 16 个提交，只改 Android、macOS 和 `docs/evidence/ask-question-card`，Web 构建输入、P0 测试与证据目录都不变）。登记提交直接建在 `cc16cb214` 上，最终检查都在它上面做。
- 没有推送 main 或项目分支，没有部署或发布。

## 环境与方法

与第 7 批相同（工具在 [tools/](tools/)，大多取自 [p0-drift-7/tools](../p0-drift-7/tools/)，只改了路径）：
- **依赖**：`/mnt/data` 上两个 worktree（`wt/base`、`wt/reg`）各自按锁文件隔离安装：`npm ci --offline --ignore-scripts --include=dev --include=optional`（[setup-base.sh](tools/setup-base.sh)）。本批涉及的所有提交 `package-lock.json` 都相同（blob `f03a6e32…`）。
- **环境**：每次浏览器运行都由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过，写出的 environment.json 都与 P0.2 记录逐字节相同（SHA-256 `fe69e824…`，各运行的哈希在 [attribution/runs/](attribution/runs/) 的 `environment.sha256`）。
- **精简构建树**（[prepare-tree.sh](tools/prepare-tree.sh)）：`git archive` 取出 Web 构建会读的文件，依赖共用 `wt/base` 的安装，`@orbit/shared` 链接到这棵树自己的 `src/shared`，按 `pretest:ui-migration` 构建并记下产物每个文件的 SHA-256（[attribution/dists/](attribution/dists/)）。核对：新基础 `bcf00ab95` 这样构建的产物，24 个文件与 `wt/base` 里 P0 原命令 pretest 构建的逐字节相同（[dists/wt-base-pretest.sha256](attribution/dists/wt-base-pretest.sha256)）。
- **运行器**（[make-runner.sh](tools/make-runner.sh)）：P0 测试从运行器目录运行，被测树只提供生产构建和 `npm run preview`（[p0d8.config.mjs](tools/p0d8.config.mjs)，与第 7 批的 p0d7.config.mjs 相同）。`tip` 是新基础 `bcf00ab95` 的 P0 测试，归因用的 17 次完整矩阵都用它；`reg` 是登记提交 `4882b380e` 的 P0 测试（与 `tip` 只差两个登记层），只用于负对照。本批下钻到的提交都在 P4.1 之后（最早的是 `a68f07f74`，10-09），`tip` 的设置页、资料页场景在每棵树上都能走完，不需要旧树自己的测试。`tip` 与这些树自己的 P0 测试相比，P0 矩阵用到的文件只差三处：P4.4 维护的 Wiki 场景取样定位（`page-scenarios.mjs` 的 `surface: dialog`，只影响计算样式取样，不影响截图），第 7 批补的 `GET /api/auth/capabilities` 固定响应（`fixtures.mjs`；`ec881f633` 和 T7 一线的 `a68f07f74`、`3a3c58c1f`、`e2e5196f0` 自己的测试还没有它，这些树都发这个请求，用自己的测试会停在固定数据校验），`playwright.config.mjs` 的忽略清单（多了不在矩阵里的新用例文件）。
- **运行方式**（[run.sh](tools/run.sh)）：完整矩阵是 pages、states、breakpoints 三个文件，80 个测试、252 张截图，截图写入空的临时目录（`--update-snapshots=all`），每张都能截到，再逐张比较；固定数据校验、定位和页面异常照常判定。每次运行在独立网络命名空间里（`unshare -n`），保持 P0 的 `http://127.0.0.1:4173`。Playwright 用 P0 配置的 1 个 worker。两条队列可能走到同一次运行或构建，第一个用原子的 `mkdir` 锁拿走，另一个跳过或等它构建完（本批新加，见 run.sh、prepare-tree.sh）。
- **比较与噪声**（[compare.cjs](tools/compare.cjs)，与第 2、3、5、7 批相同）：逐像素差异，加上 P0 比较器在 `maxDiffPixels: 0`、默认 threshold 下的结论。按 p0-drift README「Chromium 渲染噪声」判定「变化」：比较器不通过，或 WebKit 有任一像素不同，或 Chromium 单通道差超过 4 或超过 200 像素；其余记为噪声。每组比较在 [compare/](compare/)，一行汇总在 [compare/summary-last.json](compare/summary-last.json)（[pairs.sh](tools/pairs.sh)、[compare-summary.py](tools/compare-summary.py)）。
- **正式运行**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `/mnt/data` 的 worktree 里、独立网络命名空间里运行（[round.sh](tools/round.sh) 调用 [netns-regression.sh](tools/netns-regression.sh)，两轮由 [final-rounds.sh](tools/final-rounds.sh) 连着跑）。

## 失败清单

### 开工时：新基础 `bcf00ab95`

在新基础 `bcf00ab95` 的 `/mnt/data` 检出上运行 P0 原命令（作业 `bgj_2ebf26dbe2da`，[checks/base-start](checks/base-start/summary.json)）：112 个测试，73 通过、11 个已记录的跳过、**28 失败**、0 flaky，退出码 1。期望组装输出 `P0 expected screenshots: 44 P0.2 originals, 183 main drift references, 25 accepted migration differences.`，环境记录与 P0.2 逐字节相同，没有 `unhandled`，没有页面异常。

| 用例 | 项目 | 停在 | 期望来源 | Playwright 报告的差异像素（明桌面、暗桌面、明手机、暗手机） |
| --- | --- | --- | --- | --- |
| task | 8 个项目 | task-detail.png | main 漂移参考（第 1 批 A4；桌面第 7 批 A12） | Chromium 11716、10844、5285、4823；WebKit 11318、10460、4810、4321 |
| settings | 8 个项目 | settings.png | main 漂移参考（第 1、5、7 批） | Chromium 12620、13478、2363、2522；WebKit 12691、13435、2421、2553 |
| session | 8 个项目 | session-idle.png | main 漂移参考（第 1、7 批） | Chromium 5149、4970、5154、4955；WebKit 5019、4710、5062、4723 |
| 断点巡检 | 4 个桌面项目 | breakpoint-599-dialog.png | main 漂移参考（第 1 批 A4） | Chromium 3037、2569；WebKit 2768、2333 |

- **与起因报告的对照**：起因报告的是 settings 8 个；协调者的补充线索在起点 `1d97733fb`（树与当时的项目 tip `d354b64c5` 相同）上看到同样的 28 个。新基础比 `d354b64c5` 多了 tasks 工具栏和 Select/Close 两批迁移，它们不改变任何 P0 截图（见「归因」），失败的用例与差异图都相同。
- **被挡住的截图**：每个用例在第一处失败就停下，后面的截图（task 的 hover/focus/menu/share、settings-saved、会话页其余 5 张、断点的 601px 对话框与 959/961px 会话等）在完整失败面里一并处理。
- 差异图样例：[settings（chromium-light-desktop）](checks/base-start/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)、[task-detail（chromium-light-desktop）](checks/base-start/failures/pages.browser.mjs-task-chromium-light-desktop/task-detail-diff.png)、[session-idle（chromium-light-phone）](checks/base-start/failures/pages.browser.mjs-session-chromium-light-phone/session-idle-diff.png)。
- **其余 73 个通过**：pages 的 share、projects、wiki、profile 各 8，states 16，P2.3 生产通知 8，P0.2-FOCUS-1/2 16，性能 1。**11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检，与前几批相同。

### 完整失败面

用 update 模式在新基础上截全 252 张（[full-base](attribution/runs/full-base/meta.json)，76 通过、4 跳过、0 失败，没有 `unhandled`），再对照开工时组装的期望逐张比较（[compare/expected__base.json](compare/expected__base.json)）：

| 结果 | 截图 | 张数 |
| --- | --- | ---: |
| 不通过 P0 比较器：A16 任务详情 Engine 行 | task-detail、task-action-hover、task-action-focus、task-action-menu、task-share-dialog（8 个项目，40），breakpoint-599-dialog、breakpoint-601-dialog（4 个桌面项目，8） | 48 |
| 不通过 P0 比较器：A15 设置页 Session recaps | settings、settings-saved（8 个项目） | 16 |
| 不通过 P0 比较器：A17 回合头 Worked for | session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged、notification-error（8 个项目，48），breakpoint-959-session、breakpoint-961-session（4 个桌面项目，8） | 56 |
| 通过，低于阈值：P4.4 的迁移差异，不登记 | wiki-new-entry（Chromium 手机 2 张：18141、28455 个像素，单通道差 ≤2；WebKit 4 张：8–17 个像素，单通道差 1） | 6 |
| 通过，低于阈值：此前已记录，不属本批 | P4.3b 的 WebKit 桌面 project-graph-fullscreen 2 张（9、17 个像素，单通道差 1）；WebKit 滚动锁一批的 webkit-light-phone profile-validation（文档滚动条一列，6753 个像素） | 3 |
| 通过 | 逐字节相同 112 张，Chromium 噪声 11 张 | 123 |

**120 张就是本批要处置的全部失败截图**。9 张低于阈值的在逐张表里列出（[attribution/per-screenshot.md](attribution/per-screenshot.md) 里标着「不登记」「不属本批」的 9 行），都不登记，理由见「归因」的「低于阈值的 9 张」。此前已记录的另外 14 张低于阈值差异（P3.2 的 9 张、WebKit 滚动锁的 1 张、A14 落在已接受层的 4 张）这次都落在 120 张里，随本批登记一并处理（见「登记清单」）。

## 归因

按 main 漂移参考第 4 条 (a)–(f)，120 张截图逐张归因到单个 main 提交：逐张的表在 [attribution/per-screenshot.md](attribution/per-screenshot.md)，全部数据（每组比较的类别、像素、git 事实）在 [attribution/attribution.json](attribution/attribution.json)，由 [attribution.py](tools/attribution.py) 从记录的运行算出。**120 张都满足每一步，0 张归因不到 main。** 三处改动都来自 main 的产品提交；区间里的迁移提交没有改变这些截图。

**项目线上发生了什么**：第 7 批落地后，项目分支 first-parent 历史依次是 `7a5a6880a`（第 7 批证据）、`baad1a557`（吸收 main `ec881f633`）、`cb35d126a`（吸收 main `46e28aaa3`）、P4.4 的 6 个提交（`904a0dcca`…`d580e572d`）、`2fcd654d8`（吸收 main `c26b69643`）、`d354b64c5`（吸收 main `9498167b9`）、tasks 工具栏的 3 个提交、`951882866`（合入 Select/Close 一批）。新基础 `bcf00ab95` 是 main 晋升 `951882866` 的合并，树与它相同。每个吸收 main 的合并都跑了完整矩阵，迁移提交按段跑两端（P4.4 一段的两端是 `cb35d126a`、`d580e572d`，tasks 工具栏与 Select/Close 一段的两端是 `d354b64c5`、`951882866`）；Web 构建输入相同的只跑一次：`baad1a557` 与 `ec881f633` 相同，`cb35d126a` 与 `46e28aaa3` 的树相同。

| 项目线一步 | 对照 | 结果 |
| --- | --- | --- |
| 当前期望 → `baad1a557`（= `ec881f633`） | [expected__ec881f633](compare/expected__ec881f633.json) | 252 张都通过比较器：214 张逐字节相同，21 张噪声，其余 17 张只有已记录的低于阈值差异（P3.2 9、WebKit 滚动锁 2、A14 落在已接受层 4、P4.3b 2） |
| `baad1a557` → `cb35d126a`（= main `46e28aaa3`） | [ec881f633__46e28aaa3](compare/ec881f633__46e28aaa3.json) | 设置页 16 张变，都不通过比较器（A15），其余没有变化 |
| `cb35d126a` → `d580e572d`（P4.4） | [46e28aaa3__d580e572d](compare/46e28aaa3__d580e572d.json) | 0 张比较器失败；只有 6 张 wiki-new-entry 低于阈值（P4.4 的迁移差异，见下） |
| `d580e572d` → `2fcd654d8` | [d580e572d__2fcd654d8](compare/d580e572d__2fcd654d8.json) | 任务详情 48 张变，都不通过比较器（A16） |
| `2fcd654d8` → `d354b64c5` | [2fcd654d8__d354b64c5](compare/2fcd654d8__d354b64c5.json) | 会话页 56 张变，都不通过比较器（A17） |
| `d354b64c5` → `951882866`（= 新基础） | [d354b64c5__base](compare/d354b64c5__base.json) | 0 张变化，WebKit 126 张全部逐字节相同：tasks 工具栏、Select/Close 两批迁移不改变任何 P0 截图 |

### A15 设置页 Session recaps：main `46e28aaa3`（合入 `83671b995`），16 张

**变化**：`83671b995`（feat(clients): the session list shows the server's recap, behind one account switch (0418)）给设置页 Session defaults 卡片加了 Session recaps 开关（`SettingsPage.tsx` 13 行），在 Suggested replies 下面多出一行，其下的内容随之下移（桌面 80px）。settings、settings-saved 在 8 个项目都变，共 16 张。差异在设置卡片列：Chromium 桌面 x 500–1059、y 408–899，手机 x 16–373、y 718–843；WebKit 另含页面自己的滚动条（`.app-view`，右侧 8px）随页面变长而变短的滑块，桌面到 x 1279，手机从 y 353 起。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 first-parent | `baad1a557`（= `ec881f633`）：复现当前期望 | `cb35d126a`（Merge refs/heads/main into refs/heads/project/34ZZeq0e3IR65GVm2kAs7，第二父 `46e28aaa3`，两者树相同）：16 张都变 | — |
| (b) main first-parent（`cb35d126a` 的第二父线，从 `ec881f633` 起 12 个提交） | `ec881f633` → X^1 `56c21bdd2`：252 张 0 张变化，WebKit 全部逐字节相同（这一段含本项目的晋升 `e5404b73b` 和 `2255a5313` 进入 main 的 `d23062aaf`） | **X `46e28aaa3`**：16 张都变，都不通过比较器，其余 236 张没有变化 | X 就是区间终点 |
| (b) 合并内部：`46e28aaa3` 第二父 `43e0eadeb` 的 first-parent 线（merge base `f6bf9f496`） | `92ce415e9`（Merge refs/heads/main into refs/heads/project/34d0oH4R6LErqqsox7wYv，Web 构建输入与 `f6bf9f496` 相同；产物与 `56c21bdd2` 逐文件相同） | **`83671b995`**：同样 16 张都变，都不通过比较器 | 线的终点 `43e0eadeb` 与 `83671b995` 的 Web 构建输入相同；`83671b995` 与 `46e28aaa3` 的产物逐文件相同，两次运行 0 张变化 |

- **(c) X 在 main 上，不是本项目的晋升合并**：`46e28aaa3` 是项目 34d0oH4R6LErqqsox7wYv（会话摘要）的合并，在 origin/main 的 first-parent 上，不是 `Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`。变化来自产品代码：`83671b995` 的 Web 部分是 `SettingsPage.tsx`、`WorkspaceView.tsx`、`lib/queries.ts`（另有两个单测），不是迁移组件；提交说明写明 “the web's Session defaults card” 加了这个开关。同一项目更早的 `2255a5313`（the session list's second line prefers the server's recap）经 `d23062aaf` 进入 main，P0 截图在那里 0 张变化（P0 的会话固定数据没有 recap）。
- **为什么 X 记 `46e28aaa3`**：与第 7 批 A12 相同，参考图要在含当前期望里全部已登记 main 改动的树上生成，所以取项目线经过的 main 合并，`mainCommits` 把产品提交 `83671b995` 写在 `46e28aaa3` 前面，`generatedFrom` 是最后一个 `46e28aaa3`。这里两者产物逐文件相同，取哪一个截图都一样。
- **(d) X 的树里没有影响这些截图的迁移改动**：`46e28aaa3` 含本项目到 `baad1a557` 为止晋升进 main 的迁移代码（经 `e5404b73b`，含 P4.1 的设置页和 WebKit 滚动锁修复）。前驱 `56c21bdd2` 上这 16 张对照当前期望：15 张逐字节相同，webkit-light-phone 的 settings-saved 只差 WebKit 滚动锁一批记录的文档滚动条一列（6753 个像素，比较器通过）。所以迁移代码没有改变这 16 张。已接受层里的 3 张和带着已接受、低于阈值迁移差异的 1 张，按已接受层第 6 条第二种情况处理，不更新 main 漂移层，见「登记清单」。
- **(e) 参考图**：用 `46e28aaa3` 的树、`tip` 运行器、P0.2 环境生成（[full-46e28aaa3](attribution/runs/full-46e28aaa3/meta.json)）。它与新基础 `bcf00ab95` 的这 16 张逐字节相同或只差噪声。
- 对照图（左 X^1，右 X）：[设置卡片裁切（chromium-light-desktop settings）](attribution/images/A15--chromium-light-desktop--settings--crop.png)、[整页](attribution/images/A15--chromium-light-desktop--settings.png)、[合并内部 `92ce415e9` → `83671b995`](attribution/images/A15-drill--chromium-light-desktop--settings--crop.png)。

### A16 任务详情 Engine 行：main `e69765706`（合入 T7 的 `3a3c58c1f`），48 张

**变化**：`3a3c58c1f`（feat(web): sessions, tasks and workspaces pick the engine, then a provider it runs (T7)）让任务详情的 Details 在 Assignee 下面多出一行 Engine（灰字 Codex），原来写着 Codex 的 Provider 一行改为 Sign-in on Baseline runner，其下的内容随之下移约 32px。task 场景的 5 张截图（task-detail、task-action-hover、task-action-focus、task-action-menu、task-share-dialog）在 8 个项目都变，断点巡检的 599px、601px 分享对话框在 4 个桌面项目都变（对话框遮罩下的任务面板），共 48 张。差异都在任务面板：桌面 x 615–1279、y 199–842；手机 x 0–389、y 278–731；对话框截图 y 从 291（桌面）或 375–544（手机）起；599/601px x 0–600、y 199–814。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 | `d580e572d`（P4.4 之后）：与 `cb35d126a` 只差 P4.4 的 6 张 wiki-new-entry（低于阈值） | `2fcd654d8`（Merge origin/main (c26b69643: T7 engines/providers) into project/34ZZeq0e3IR65GVm2kAs7 (P4.4)，第二父 `c26b69643`）：48 张都变 | — |
| (b) main first-parent（`2fcd654d8` 第二父线，merge base `46e28aaa3` 之后 3 个提交） | X^1 `46e28aaa3`：对照当前期望，这 48 张通过比较器（30 张逐字节相同、9 张噪声，其余 9 张只有 P3.2 已记录的低于阈值差异） | **X `e69765706`**：48 张都变，都不通过比较器 | `e223d8eed` 不改 Web 构建输入；`c26b69643` 与 X 相比 0 张变化，WebKit 全部逐字节相同 |
| (b) 合并内部：`e69765706` 第二父 `50147192e` 的 first-parent 线（merge base `56c21bdd2`） | `c5447f6bf`（Web 构建输入与 `56c21bdd2` 相同） | `50147192e`（Merge refs/heads/orbit/t7-web-engine-provider-9e7223 into refs/heads/project/34ccMg4EoSorpVooMC4kg）：同样 48 张都变 | `50147192e` → `e69765706` 只差 A15 的 16 张（`50147192e` 不含 `46e28aaa3`），这 48 张不变 |
| (b) T7 一线：`50147192e` 第二父 `df0bef43d` 的 first-parent 线（最早的是 `3a3c58c1f`，它的父提交 `a68f07f74` 是 T7 分出的地方） | `a68f07f74`：与 `56c21bdd2` 0 张变化，WebKit 全部逐字节相同 | **`3a3c58c1f`**：48 张都变，都不通过比较器 | `3a3c58c1f` → `e2e5196f0` 0 张变化；`e2e5196f0`、`3a3c58c1f` 与 `50147192e`（= 线的终点 `df0bef43d` 的 Web 构建输入）0 张变化，WebKit 全部逐字节相同 |

- **(c)**：`e69765706` 是项目 34ccMg4EoSorpVooMC4kg（provider 引擎）的合并，在 origin/main 的 first-parent 上，不是本项目的晋升合并。变化来自产品代码 `3a3c58c1f`（`TaskDetailPanel.tsx`、`lib/sessionProviderChoices.ts`、`lib/workspaceDefaults.ts` 等，T7 的 Engine/Provider 选择）。同一分支的 `e2e5196f0`（fix(web): the task pin lists account pools; the engine list fits its names (T7)）也改了 `TaskDetailPanel.tsx`，但不改变任何 P0 截图，所以 `mainCommits` 只写 `3a3c58c1f`、`e69765706`。
- **(d)**：`e69765706` 的树含已晋升的迁移代码（P3.2 的任务详情与分享对话框等）。前驱 `46e28aaa3` 上这 48 张对照当前期望都通过比较器，不同之处只有 P3.2 已记录的低于阈值差异（深色手机 task-action-menu 2 张，webkit-dark-phone 的 task-detail/hover/focus 3 张，WebKit 桌面的 599/601px 对话框 4 张）。所以迁移代码没有改变这 48 张。已接受层的 14 张和带着已接受、低于阈值迁移差异的 9 张，按已接受层第 6 条第二种情况处理，见「登记清单」。
- **(e) 参考图**：用 `e69765706` 的树、`tip` 运行器、P0.2 环境生成（[full-e69765706](attribution/runs/full-e69765706/meta.json)）。
- 对照图：[Details 区裁切（chromium-light-desktop task-detail）](attribution/images/A16--chromium-light-desktop--task-detail--crop.png)、[T7 一线 `a68f07f74` → `3a3c58c1f`](attribution/images/A16-drill--chromium-light-desktop--task-detail--crop.png)。

### A17 回合头 Worked for：main `d2e295917`，56 张

**变化**：`d2e295917`（feat(web): a worked-for row at the head of every turn, over its own output）在每个结束的回合上方、助手回复之前加一行 “Worked for 1s”（`Transcript.tsx` 51 行、`index.css` 11 行），其下的内容随之下移。时长取自固定数据里这一回合的两条事件时间，不到 1 秒按提交的规则写成 1s，每次运行都相同（P0 的时钟也是固定的）。会话页的 6 张截图在 8 个项目都变，断点巡检的 959px、961px 会话截图在 4 个桌面项目都变，共 56 张。差异都在消息列：桌面 x 633–1259、y 183–519；手机 x 26–375、y 195–576；959px 会话 x 26–420，961px x 633–882。

| 层级 | 前驱（不变） | 改变的提交 | 区间终点 |
| --- | --- | --- | --- |
| (a) 项目线 | `2fcd654d8`：除 A16 外与 `d580e572d` 相同 | `d354b64c5`（Merge refs/heads/main into refs/heads/orbit/p4-4-upstream-main-t7-wikisettingspage-8e59f1，第二父 `9498167b9`）：56 张都变 | 新基础与 `d354b64c5` 0 张变化 |
| (b) main first-parent（`d354b64c5` 第二父线，merge base `c26b69643` 之后 22 个提交） | X^1 `c26b69643`：对照当前期望，这 56 张通过比较器（52 张逐字节相同或噪声，WebKit 的 notification-error 4 张只差第 7 批记录的 A14 低于阈值渐隐） | **X `d2e295917`**：56 张都变，都不通过比较器 | `9498167b9` 与 X 相比 0 张变化，WebKit 全部逐字节相同 |

- **(c)**：`d2e295917` 是 origin/main first-parent 上的单个非合并提交，不是本项目的晋升合并；改的是 `Transcript.tsx` 和 `index.css`（另有一个单测与设计稿），是产品代码。
- **(d)**：`d2e295917` 的树含已晋升的迁移代码。前驱 `c26b69643` 上这 56 张对照当前期望都通过比较器，只差已记录的低于阈值差异，所以迁移代码没有改变它们。已接受层的 4 张 notification-error 按已接受层第 6 条第二种情况处理。
- **(e) 参考图**：用 `d2e295917` 的树、`tip` 运行器、P0.2 环境生成（[full-d2e295917](attribution/runs/full-d2e295917/meta.json)）。它含第 7 批登记的 A13、A14。
- 对照图：[回合头裁切（chromium-light-phone session-idle）](attribution/images/A17--chromium-light-phone--session-idle--crop.png)、[整页（webkit-dark-desktop session-idle）](attribution/images/A17--webkit-dark-desktop--session-idle.png)。

### 低于阈值的 9 张

- **P4.4 的 6 张 wiki-new-entry，不登记**：只在项目线 `cb35d126a` → `d580e572d`（P4.4 把 Wiki 新条目对话框换成 Orbit Dialog）这一步变化，比较器通过：Chromium 手机 2 张是遍及对话框区域的抗锯齿级差异（18141、28455 个像素，单通道差 ≤2），WebKit 4 张是对话框四角的 8–17 个像素（单通道差 1）。像素数与 P4.4 自己的同提交对照（[p4.4/compare/p0-compare.json](../p4.4/compare/p0-compare.json)）逐张相同，那一版证据已由协调者判定。它是迁移差异，不能登记为漂移；登记工具不收比较器看不见的差异，也不进已接受层。仍对照 main 漂移参考通过。main 树（`46e28aaa3`、`c26b69643`、`9498167b9`）上没有这项差异，项目线吸收 main 的 `2fcd654d8`、`d354b64c5` 对照它们也只差这 6 张。
- **此前已记录的 3 张，不属本批**：P4.3b 的 WebKit 桌面 project-graph-fullscreen 2 张（9、17 个像素，单通道差 1，第 7 批记录）；webkit-light-phone 的 profile-validation（WebKit 滚动锁一批的文档滚动条一列，仍是 P4.1 的接受条目）。在本批每棵树上都一样。

### 新基础与 main 的其余部分

- `d354b64c5` → `951882866`（tasks 工具栏 `3a65947f9`、`e1dd199e4`、`00675b7b2`，Select/Close 一批 `951882866`）：0 张变化，WebKit 全部逐字节相同；
- `bcf00ab95` → origin/main `cc16cb214`（登记前 main 的位置）：Web 构建输入、P0 测试、`docs/evidence/base-ui-migration` 都不变（`git diff --quiet` 为真），没有重跑。

## 登记清单

一个登记提交 `4882b380e`（test(web): register P0 drift batch 8: Session recaps, the task Engine row, the worked-for row），建在 origin/main `cc16cb214` 上，只改 `p0-drift/reference/`、`p0-drift/accepted/` 和 [p0-drift README](../p0-drift/README.md) 两个登记层的清单段落（154 个文件；README 14 行增、4 行删），可单独回退。登记后期望组装为 **`44 P0.2 originals, 173 main drift references, 35 accepted migration differences`**（登记前 `44 / 183 / 25`）。

### main 漂移参考层：替换 89 条

工具是 [make-reference.py](tools/make-reference.py)（第 7 批的同名工具），输入是 [spec-a15.json](tools/spec-a15.json)、[spec-a16.json](tools/spec-a16.json)、[spec-a17.json](tools/spec-a17.json)。

| 归因 | 截图 | 张数 | `mainCommits` 追加 | 生成树（运行） | `projectLine` 追加 |
| --- | --- | ---: | --- | --- | --- |
| A15 | settings（8 个项目），settings-saved（Chromium 4 个项目） | 12 | `83671b995`、`46e28aaa3` | `46e28aaa3`（full-46e28aaa3） | `cb35d126a` |
| A16 | task-detail、task-action-hover、task-action-focus（webkit-dark-phone 以外的 7 个项目，21），breakpoint-599-dialog、breakpoint-601-dialog（Chromium 桌面 2 个项目，4） | 25 | `3a3c58c1f`、`e69765706` | `e69765706`（full-e69765706） | `2fcd654d8` |
| A17 | session-idle、session-streaming、session-composer-focus、session-attachment-menu、session-attachment-staged（8 个项目，40），notification-error（Chromium 4 个项目），breakpoint-959-session、breakpoint-961-session（4 个桌面项目，8） | 52 | `d2e295917` | `d2e295917`（full-d2e295917） | `d354b64c5` |

- **替换的 89 条**：每条只改 `sha256`、`mainCommits`、`generatedFrom`、`projectLine`、`change` 五个字段，旧的提交号都留在列表前面，`group`、`p0Baseline` 不变；其余 117 条逐字段不变（工具运行后用 registry 逐条核对）。每条的 `mainCommits` 都是它 `generatedFrom` 的祖先。没有 `migrationFix` 条目受影响。
- **不在本层更新的截图**：已接受层承接的 31 张（下一节）在 main 漂移层保持原样。

### 已接受层：第 6 条第二种情况，31 次登记、10 条新条目

X 的树（`46e28aaa3`、`e69765706`、`d2e295917`）都已含这些页面的已接受迁移代码（P3.2 的晋升，WebKit 滚动锁修复 `9f2f7e9a0`），所以按第 6 条第二种情况：**不更新 main 漂移层**，同提交对照的 before 取 X 的 first-parent 前驱树，after 取 X 的树，差异说明写明这是叠在已接受差异上的 main 改动，并指向本目录的归因证据。**每条都引用原判定**（从 registry 里带着它的条目读出，不手抄摘要），登记工具把旧条目移入 `previous`。命令在 [register-accepted8.sh](tools/register-accepted8.sh)（调用 [register-accepted.cjs](../p0-drift/tools/register-accepted.cjs)），差异说明全文在 [accepted/registry.json](../p0-drift/accepted/registry.json)。

| 步 | 截图 | 条数 | 原判定 | before → after | 被替换的期望（`replaces`，不变） |
| --- | --- | ---: | --- | --- | --- |
| A15 | settings-saved（WebKit 桌面 2 个项目，webkit-dark-phone） | 3 | WebKit 滚动锁（[34cBi0yt6bFcSmbJFgDPj](orbit-task:34cBi0yt6bFcSmbJFgDPj)）第 1 版，`evidenceDigest` `fdb19816…8e7c`，CONFIRM（判定记录 `fRJrSzK3CevsTPV4xEki6`），[webkit-scroll-lock/README.md](../webkit-scroll-lock/README.md) | `56c21bdd2` → `46e28aaa3` | 设置页组的 main 漂移参考（`def134095`） |
| A15，首次登记 | settings-saved（webkit-light-phone） | 1 | WebKit 滚动锁第 1 版（同上） | `56c21bdd2` → `46e28aaa3` | 设置页组的 main 漂移参考（`def134095`） |
| A16 | task-share-dialog（8 个项目），task-action-menu（浅色 4 个项目、深色桌面 2 个项目） | 14 | P3.2（[34Za39ACSBoCkYKc80Md8](orbit-task:34Za39ACSBoCkYKc80Md8)）第 2 版，`evidenceDigest` `302ca1f5…09bc`，CONFIRM，[p3.2/README.md](../p3.2/README.md) | `46e28aaa3` → `e69765706` | 第 1 批 A4 的 main 漂移参考 |
| A16，首次登记 | task-action-menu（深色手机 2 个项目），webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，breakpoint-599/601-dialog（WebKit 桌面 2 个项目，4） | 9 | P3.2 第 2 版（同上） | `46e28aaa3` → `e69765706` | 第 1 批 A4 的 main 漂移参考 |
| A17 | notification-error（WebKit 4 个项目，叠在第 7 批 A13 那一条上） | 4 | WebKit 滚动锁第 1 版（同上） | `c26b69643` → `d2e295917` | 桌面 2 张为会话组的 main 漂移参考，手机 2 张为 P0.2 原图 |

- **登记工具的三项检查都通过**：两次运行都在 P0.2 环境；before 原件在 P0 比较器下复现当前期望（21 条重登的 before：A15、A16 的 17 张与当前已接受期望逐字节相同，A17 的 4 张只差第 7 批记录的 A14 渐隐，比较器通过）；after 与 before 不一致。
- **首次登记的 10 条**：深色手机的 task-action-menu 2 张，webkit-dark-phone 的 task-detail、task-action-hover、task-action-focus，WebKit 桌面的 breakpoint-599/601-dialog 4 张，webkit-light-phone 的 settings-saved，此前都没有已接受条目。它们的当前期望（main 漂移参考）上带着一项已由协调者 CONFIRM、但低于比较器阈值、登记工具不收的迁移差异：P3.2 的深色菜单（Chromium 627、WebKit 655 个像素，单通道差 45）、webkit-dark-phone 任务详情的 66 个像素（单通道差 1）、WebKit 桌面 599/601px 对话框的 8、11 个像素（单通道差 1），WebKit 滚动锁一批的文档滚动条那一列（6753 个像素）。含 X 的每一棵 main 树都带着这些迁移像素：在 X 的树上重新生成 main 漂移参考，就会把迁移像素放进 main 漂移层，违反「迁移改动永远不能登记为漂移」。所以这 10 张按第 6 条第二种情况的做法叠加登记，引用同一判定，main 漂移层不动。这与第 7 批对深色桌面 task-action-menu、WebKit 明色手机 notification-error 的做法相同，协调者在第 7 批的判定里接受过；第 6 条的文字写的仍是「已有登记的截图」，见「缺口与边界」。
- **`previous`**：21 条重登的旧条目移入 `previous`；它们原来的 after 分别是第 7 批的 `cbe6a6635`（A12）、`3960c19c2`（A13），P3.2 的 `2925958ae`，WebKit 滚动锁一批的 `b2568f28d`。
- **A14 进入已接受层**：WebKit 的 4 张 notification-error 原来停在第 7 批 A13 那一条（不含 A14，A14 低于阈值）；这次的 after 原件在含 A14 的 `d2e295917` 上生成，期望里随之有了 A14。
- **没有受影响的其它已接受条目**：webkit-light-phone 的 profile-validation（P4.1），WebKit 桌面和 webkit-dark-phone 的 profile-validation（滚动锁）都不在 120 张里，`replaces` 仍然匹配，没有动。

### 登记后的核对

在登记提交的树上用 P0 的 globalSetup 组装期望：校验全部通过，输出 `P0 expected screenshots: 44 P0.2 originals, 173 main drift references, 35 accepted migration differences.`。新基础的 252 张（update 模式，full-base）对照登记后的期望：**0 张比较器失败**，231 张逐字节相同、12 张噪声，其余 9 张低于阈值，就是上面的 9 张（P4.4 6、P4.3b 2、WebKit 滚动锁 1）（[compare/registered__base.json](compare/registered__base.json)）。

## 验证

### 两轮完整 P0：登记提交 `4882b380e`

- **树**：`4882b380e`，即 origin/main `cc16cb214` 加本批的登记提交。之后只有最后的证据提交，只在本目录增加文件，不改 `src/`、`reference/`、`accepted/`。
- **命令**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，在 `/mnt/data` 的检出 `wt/base` 里，独立网络命名空间，紧接着跑两轮（[final-rounds.sh](tools/final-rounds.sh)，作业 `bgj_426b7f01bee4`）。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮（05:43:37–05:48:58 UTC，含 pretest 构建） | 112 个测试：101 通过、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final8-1](checks/final8-1/summary.json)（含 `report.summary.json`、`command-output.txt`、`sources.json`、`evidence-digest.json`） |
| 第 2 轮（同一作业，紧接其后，05:49:20–05:54:37 UTC） | 同上，112 个测试逐个状态相同 | [checks/final8-2](checks/final8-2/summary.json)、[两轮对照](checks/final8-compare.json)（`identical: true`） |

- 两轮的期望组装都输出 `P0 expected screenshots: 44 P0.2 originals, 173 main drift references, 35 accepted migration differences.`，globalSetup 对两个登记层的校验都通过；环境记录与 P0.2 逐字节相同（`fe69e824…`）；运行时检出干净（`command-output.txt` 第一行）。
- **101 个通过**：pages 56（task、share、projects、wiki、settings、profile、session 各 8）、states 16、断点巡检 4（桌面）、P2.3 生产通知 8、P0.2-FOCUS-1/2 16、性能 1。**11 个跳过**：7 个非参考项目的性能采样、4 个手机项目的桌面断点巡检。没有预期失败。
- **结果只含已记录的处置**：开工时失败的 28 个用例都通过；本批处置的 120 张都对照本批登记的期望（`sources.json` 逐张写着来源层：89 张是 main 漂移参考，`mainCommits` 最后一个是 `46e28aaa3` 12 张、`e69765706` 25 张、`d2e295917` 52 张；31 张是已接受条目，判定是 P3.2 23 张、WebKit 滚动锁 8 张）；低于阈值的 9 张（P4.4 的 6 张、P4.3b 2 张、WebKit 滚动锁 1 张）照常通过比较器。两轮都没有 `unhandled`（104 个用例的 evidence.json 全部为空），没有页面异常。

### 负对照

同一个补丁（[nc-1px.diff](tools/nc-1px.diff)）在登记提交 `4882b380e` 上以临时提交 `c5020489d`（只留在本地分支 `p0d8/negative-control-1px`，不交付）运行（[negative-control.sh](tools/negative-control.sh)，在 `/mnt/data` 的另一个检出 `wt/reg` 里，作业 `bgj_7f28e1631a8d`）。补丁把本批新登记的三行各右移 1 像素：
- 设置页 Session recaps 一行的标题 `marginLeft: 1`（A15，`SettingsPage.tsx`）；
- 任务详情 Engine 一行的标签 `marginLeft: 1`（A16，`TaskDetailPanel.tsx`）；
- 回合头 `.chat-turn-head` 的左内边距 12px → 13px（A17，`index.css`）。

| 对照 | 结果 | 记录 |
| --- | --- | --- |
| P0 原命令 | 112 个测试：73 通过、11 跳过、**28 失败**，退出码 1。**28 个失败都停在本批登记的截图上**：settings（A15，8 个项目）、task-detail（A16，8 个项目，其中 webkit-dark-phone 是本批首次登记的已接受条目）、session-idle（A17，8 个项目）、breakpoint-599-dialog（A16，4 个桌面项目，WebKit 2 张是本批首次登记的已接受条目）。差异 5–256 像素。期望组装同为 44 / 173 / 35，没有 `unhandled` | [checks/negative-control-1px](checks/negative-control-1px/summary.json)、[分析](checks/negative-control-1px/analysis.json) |
| update 模式完整矩阵（`reg` 运行器），对照登记后的期望 | 本批登记的 120 张里 **112 张不通过比较器**（104–973 像素），**其余 132 张没有一张失败**。没检出的 8 张是 task-share-dialog：分享对话框盖住了 Details 的标签列（桌面居中的对话框盖住 x 380–900，手机的对话框盖住面板上半部），移动的 Engine 标签不在可见区域 | [runs/full-negative-control-1px](attribution/runs/full-negative-control-1px/meta.json)、[比较](compare/registered__full-negative-control-1px.json) |

- 结论：新登记截图上超出登记内容的 1 像素改动，P0 原命令照样失败；main 漂移层（A15、A16、A17）和已接受层的首次登记（webkit-dark-phone task-detail、WebKit 桌面 599px 对话框）都在失败之列，update 模式下已接受层的重登条目（task-action-menu、settings-saved、notification-error）也都检出。
- 差异图样例：[settings（chromium-light-desktop，Session recaps 一行）](checks/negative-control-1px/failures/pages.browser.mjs-settings-chromium-light-desktop/settings-diff.png)、[task-detail（chromium-light-desktop，Engine 一行）](checks/negative-control-1px/failures/pages.browser.mjs-task-chromium-light-desktop/task-detail-diff.png)、[session-idle（chromium-light-phone，Worked for 一行）](checks/negative-control-1px/failures/pages.browser.mjs-session-chromium-light-phone/session-idle-diff.png)。

### 合并检查

在会话工作树里运行项目的合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[merge-check-root.sh](tools/merge-check-root.sh) 调用 [merge-check.sh](tools/merge-check.sh)，包在 6G 的 cgroup 里，起跑前等到 MemAvailable ≥ 4500 MB，作业 `bgj_d14ce8c56f8b`），退出码 0：
- **树**：登记提交 `4882b380e`，运行时唯一未跟踪的路径是本目录（`status: 1 changes`）。Web 测试里只有 `RunnerEngines.antigravityGoogle.test.tsx` 读 `docs/evidence` 下的文件（antigravity-google-login 的夹具），与本批无关，所以证据提交不影响这个结果。
- **依赖**：`bash scripts/worktree-overlay.sh`，按锁文件隔离安装，`@orbit/shared` 解析到这棵树自己的 `src/shared/dist`（[overlay.txt](checks/merge-check-final/overlay.txt)）。
- **结果**：`tsc -b && vite build` 成功（4579 个模块，保留原有的大 chunk 提示）；Vitest **390 个文件、5117 个用例全部通过**，用时 307 秒（[过滤后的输出](checks/merge-check-final/output-filtered.txt)，完整输出 `output-full.txt.gz`）。
- **磁盘**：根分区开工前 10249 MB，按作业指导允许的「依赖叠加」在会话工作树（NVMe）上跑：叠加后 9330 MB，跑完 4686 MB（同时有其他会话在写根分区）；跑完后删掉了这份依赖和构建产物，根分区回到 5556 MB（[disk.txt](checks/merge-check-final/disk.txt)）。

## 跟上 main 与 audit

- **开工时**：项目 tip `951882866` 已在 origin/main `bcf00ab95` 里（树相同），按「跟上 main」快进。`audit-antd.mjs --check-owners` 在 `bcf00ab95` 上退出码 1：**2 个未归属**、0 待定（[checks/audit/audit-bcf00ab95.txt](checks/audit/audit-bcf00ab95.txt)），都来自本批漂移的来源提交：`src/web/src/components/WorkspaceView.recapRow.test.tsx`（`import { App as AntApp } from 'antd'`，`2255a5313` 加入）和 `src/web/src/index.css` 第 17902 行 `.ant-dropdown-menu-item.composer-provider-gone .scope-menu-row`（T7 的 `3a3c58c1f` 加入）。本批是漂移登记，没有迁移范围，按作业指导报告协调者（2026-10-10 05:01 UTC 前后，`project_send`），本批不动。
- **最终轮之前跟上一次**：origin/main 前进到 `cc16cb214`，`bcf00ab95` 是它的祖先，干跑无冲突；Web 构建输入、P0 测试和本证据目录都不变。登记提交直接建在 `cc16cb214` 上（快进），最终两轮、负对照和合并检查都在它上面。
- **交证据前再看 main**：交证据前 origin/main 又前进到 `d0e925f92`（`cc16cb214` 之后 2 个 first-parent 提交）：`00bb004d5` 把项目线再次晋升进 main（第二父是项目分支此时的 tip `a0b2fcb55`，P5.2 已合入项目线），带进 P5.2（Transcript 的图片与预览换成 Orbit 的 `Image`/`ImagePreview`，改了 `Transcript.tsx`、`ui/Image*`、`ui/ImagePreview*`、`index.css` 20 行和 P5.2 自己的用例）；`d0e925f92` 合入 Wiki worker 的服务端修复。`git merge-tree` 干跑没有冲突，main 没有改本批的文件（`p0-drift/` 和本目录），P0 矩阵用到的测试文件只有 `playwright.config.mjs` 的忽略清单多了 `p52*`。它改到了本批依赖的全局层（`ui/` 公共组件、`index.css`）和会话页，所以按「跟上 main」不 rebase，在临时合并树上跑标准 P0：临时提交 `16cbcc4cb`（登记提交 `4882b380e` 与 `d0e925f92` 的 `merge-tree` 加 `commit-tree`，只留在本地分支 `p0d8/maintree-d0e925f92`，不交付）上运行 P0 原命令（作业 `bgj_401393e81090`）：112 个测试，**101 通过、11 个已记录的跳过、0 失败**，退出码 0；期望组装同为 44 / 173 / 35，环境记录与 P0.2 相同，检出干净，没有 `unhandled`（[checks/maintree-d0e925f92](checks/maintree-d0e925f92/summary.json)）。这与 P5.2 自己的证据一致：它的 P0 严格比较在 P0 页面上与参照逐像素相同，标准 P0 的 28 个失败正是本批处置的这些。所以本批登记落到现在的项目 tip `a0b2fcb55` 上，标准 P0 同样全部通过（临时合并树已含它）。
- **audit 在最新 main 上**：同一棵临时合并树上 `audit-antd.mjs --check-owners` 退出码 0，0 未归属、0 待定（[checks/audit/audit-maintree-d0e925f92.txt](checks/audit/audit-maintree-d0e925f92.txt)）：开工时报告的 2 个点已由 P5.2 写的清单记录 2026-10-10、2026-10-10b 归给 P5.3（`inventory-delta/2026-10-10.json`、`2026-10-10b.json`，随 `00bb004d5` 进入 main）。

## 不变的部分

本批在 origin/main `cc16cb214` 之上有 2 个线性提交：登记 `4882b380e`，和只在本目录增加证据文件的证据提交。

核对办法：在本分支上 `git diff --stat cc16cb214 HEAD -- docs/evidence/base-ui-migration/p0.2 src/web/src src/shared src/web/ui-migration package-lock.json package.json` 输出为空（[proof.sh](tools/proof.sh) 的输出里也有这一条）。也就是说：
- P0.2 的 252 张原图、原断言、known-failures、截图比较选项（`maxDiffPixels: 0`、默认 threshold）和容差都没改；场景、harness、固定数据、期望组装和环境校验都没改；
- 产品代码和 shared 没改；
- 改了的只有：`p0-drift/README.md`（两个登记层的清单）、`p0-drift/reference/`（89 条替换）、`p0-drift/accepted/`（31 次登记，10 条新条目）和本目录。
- OrbitKit 的 *CopyParityTests 逐字读取 `src/web` 的产品源文件；本批没有改任何产品源文件，所以没有跑 swift 套件。

## 证据体积

按作业指导「证据体积」：
- **Playwright 报告**：不提交 `report.json` 和 `trace.zip`。正式运行、负对照的 P0 改交同目录的 `report.summary.json`（[report-summary.py](tools/report-summary.py)：只删附件正文，用例标题、项目、状态、耗时、重试、错误信息和附件路径都保留）。
- **归因运行**（17 次，加负对照的 1 次）只交 `meta.json`（树、运行器、参数、起止时间、退出码、统计、环境核对）、`snapshots.sha256`（每张截图的 SHA-256）、`evidence-digest.json`（每个用例截到的截图、请求、`unhandled`、页面异常）和环境记录的哈希；这些运行都没有失败，不交报告摘要。
- **截图**只提交 README 引用的：开工时 3 张、负对照 3 张差异图，7 张前驱/X 对照图。逐张比较结果在 [compare/](compare/)。
- **体积**：本目录约 8.8 MB、221 个文件（含本 README）；登记提交新增的文件（主要是 89 张参考图、31 次登记的 before/after 原件和两个 registry）约 12.5 MB；合计约 21 MB，不到 30 MB。比例最大的是 [compare/](compare/)（3.3 MB）、[checks/](checks/)（3.1 MB）和 [attribution/](attribution/)（2.2 MB）。
- **完整原始运行**：截图、报告原文、trace 和全部 evidence.json 留在 `/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG/`（`runs/`、`checks/`、两个 worktree 和临时分支 `p0d8/*`），到证据判定后再清理。

## 缺口与边界

- **已接受层的 10 条首次登记**：它们原来只对照 main 漂移参考，带着一项已 CONFIRM 但低于阈值、没有登记的迁移差异。本批没有在 main 漂移层为它们生成参考图（会把迁移像素放进 main 漂移层），而是按已接受层第 6 条第二种情况的做法叠加登记，引用 P3.2、WebKit 滚动锁的原判定。第 6 条写的是「已有已接受登记的页面」，这 10 张此前没有条目，属于延伸适用；第 7 批同样处理了 3 张，协调者判定时接受了，但规则文字还没有写进这种情况。
- **引用的是原判定**：按第 7 批的先例，重登和首次登记的条目引用原判定（P3.2 第 2 版、WebKit 滚动锁第 1 版），旧条目在 `previous`。p0-drift README 已接受层第 6 条写的是「协调者 CONFIRM 后按第 3 条重登，引用这次的判定」；本批的判定在提交证据之后才有，所以这些条目没有引用本批的判定。协调者若要求引用本批判定，CONFIRM 之后可以用同一工具和同一组原件重登一次。
- **P4.4 的 6 张 wiki-new-entry**：P4.4 的低于阈值迁移差异，登记工具不收，也不能登记为漂移，所以没有登记在任何一层；它们仍对照 main 漂移参考通过。P4.4 的同提交对照记录过同样的像素数。
- **audit 的 2 个未归属点**：来自 main 的 `2255a5313`、`3a3c58c1f`，开工时报告了协调者，本批不动（作业指导：范围外的报告协调者）；在最新 main 上它们已由 P5.2 写的清单记录归给 P5.3。
- **只跑必要的提交**：main 区间里只在每个 X 的前驱、X 和区间终点跑完整矩阵；前驱到区间起点之间改了 Web 构建输入的提交（例如 `e5404b73b`、`9c86b3dfe`、`d23062aaf`、`0cd48dad2`、`7fde56e9e`，`21f32f0c0`、`ba95b8f07`、`b4a5183e3`、`94f61b52c`）没有单独运行：区间起点与 X^1、X 与区间终点 252 张都 0 张变化，WebKit 全部逐字节相同，中间的提交没有留下改变。一个改动在区间里先出现又被撤回的情况不在这个方法的检测范围内。
- **两次重复运行**：`92ce415e9` 与 `56c21bdd2`、`83671b995` 与 `46e28aaa3` 的产物逐文件相同，两队各跑了一次，结果 0 张变化，可以当作同一产物两次运行的重复性记录。
- **精简构建树**：候选提交用 `git archive` 取出的精简树加共享依赖构建，用 `bcf00ab95` 核对过产物与 worktree 里正常构建逐字节相同，没有对每个候选提交都和完整工作树比较。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
```

归因复算（脚本在 [tools/](tools/)，写着 `/mnt/data/tmp/34dI9lY63LC7ZEZHbJ4bG` 和本工作树的路径，复跑时按环境调整）：
- 依赖：`setup-base.sh <提交>`；构建：`prepare-tree.sh <提交> [标签]`；运行器：`make-runner.sh <提交> <名字> <同 shared 的已构建树>`；
- 运行：`lane.sh <树>...`（每棵树一次 update 模式完整矩阵，可续跑，两条队列可以并行），单次 `run.sh <树> <运行器> <标签> [playwright 参数]`；
- 比较：`pairs.sh <a> <b> ...`；逐张归因 `attribution.py <工作树> <out.json> <out.md>`；对照图 `pair-images.py`；
- 登记：`make-reference.py <工作树> <spec.json>`（[spec-a15.json](tools/spec-a15.json)、[spec-a16.json](tools/spec-a16.json)、[spec-a17.json](tools/spec-a17.json)），`register-accepted8.sh a15|a16|a17`；
- 正式两轮 `final-rounds.sh <提交> <前缀> [checkout]`；负对照 `negative-control.sh <提交> <补丁> <名字> [checkout]` 与 `nc-analysis.py`；合并检查 `merge-check-root.sh`（调用 `merge-check.sh <树> <输出>`）。
