# P0 漂移登记（第 2 批）：资料页、Wiki 首页场景与断点

本目录服务于任务 [P0 漂移登记（第 2 批）：profile、wiki 场景与 959 断点](orbit-task:34bTKzXFSRGjnDevEBJlh)，对应项目验收条目 key `5wbhutjez7Qv5GCTNLb0P7`：**P7：完整迁移通过最终构建、行为与视觉回归，并有实测收益和可回退交付记录。** 按 [p0-drift README](../p0-drift/README.md)「维护规则」main 漂移参考第 3 条，这是协调者另建的「P0 漂移登记」任务。规则、参考层和清单都在 p0-drift 目录；本目录是这一批的归因、同环境证明、验证和原始记录。

## 结论

| 项目 | 结果 |
| --- | --- |
| 开工时的失败 | 项目 tip `fffcdb532`（含 B1 修复 `3ec9cf83d`）上完整 P0 有 20 个失败：breakpoint-959-wiki 桌面 ×4、profile.png ×8、wiki 场景等待 `.wk-card` 的定位失败 ×8。与 B1 任务在 `77233e226` 加修复上的结果逐项一致，像素数也相同。 |
| 完整失败面 | 失败的用例在第一处就停下，后面 40 张截图比较不到。用 update 模式把 252 张截全后，tip 对照当前期望共 **44 张**不通过 P0 比较器。另有 WebKit 的 settings ×4、settings-saved ×2 只在右侧 8px 滚动条处差 428–780 像素，低于阈值、能通过。 |
| 归因 | 44 张全部归因到 4 个 main 单提交，每张都有项目线、main first-parent 线、单提交三层同环境证明（[逐张表](attribution/per-screenshot.md)）。没有归因不到 main 的失败。<br>• `d233a6cd0`：资料页 16 张；<br>• `6c4e0ac0e`、`2f9cc095f`、`a884fda36`：Wiki 首页和断点 28 张。 |
| 场景维护 | `d2479173b`：wiki-home 截图前等待的 `.wk-card` 换成 `.wk-pl-doc.topic`。删掉卡片的是 main `2f9cc095f`；原条件在它的前驱上 8/8 通过，在它上 8/8 定位失败。截取的仍是 `/wiki/orbit` 首页整页，截图比对、断言和容差都没改。规则写进 p0-drift README「场景维护」。 |
| 有界例外 | profile-validation 中有 6 张受 B1 影响，而含 `d233a6cd0` 的每棵 main 树都带着未修的 B1。经协调者授权，这 6 张在 `d233a6cd0` 加 B1 修复的树上生成，附两项隔离证明（[isolation/](isolation/README.md)），并写成 p0-drift README main 漂移参考第 7 条。 |
| 登记 | 4 个登记提交，每个只改 `reference/` 和 p0-drift README 清单：资料页 10 张、例外 6 张、Wiki 27 张，另按第 6 条单独替换已登记的 961px 暗色 1 张。参考层从 121 张增至 164 张，88 张仍对照 P0.2。 |
| 校验扩展 | `5f81d98f5`：带 `migrationFix` 的登记缺修复提交、生成树、CONFIRM 判定或隔离证明之一，整次运行在 globalSetup 被拒。负对照 14 种情况全部按预期；扩展前的模块会放行全部 12 种破坏。第 1 批的登记规则对照（22 种破坏加 1 个合法组）仍全部按预期。 |
| 全绿两轮 | 在 `de893e974`（`fffcdb532` 加本批全部提交）上连续两轮完整 P0：每轮 112 个测试，85 通过、16 个已记录的焦点预期失败、11 个已记录的跳过，**0 失败**、0 flaky，退出码 0，两轮逐项一致。本批登记的 44 张全部通过。这棵树与交付合并的差别只有 P3.2 一批。 |
| 交付合并两轮 | 在交付合并 `304bfa6f6` 上连续两轮。这是 `--no-ff` 合到项目 tip `066d3dd30` 的合并提交，`066d3dd30` 是在 `fffcdb532` 上合入 P3.2 的结果。每轮 112 个测试：93 通过、11 个已记录的跳过、**8 失败，全是 P3.2 的 task 用例，每个项目一个**，两轮逐项一致，像素数相同。本批登记的截图和其余所有用例都通过。8 个失败逐张列在「验证」里，交给 34bSHg8V2p0zaRMKy7tUQ 登记。 |
| 负对照 | 在交付合并上用临时提交加 1px 补丁，跑 P0 原命令两次。新登记截图全部按预期失败：profile-validation ×8（含 6 条第 7 条例外登记）、breakpoint-959-wiki ×4、手机 wiki-home ×4、breakpoint-961-wiki ×4（含替换的那张）、桌面 wiki-home ×4，每张 102–1198 像素。另外只有 P3.2 那 8 个 task 失败，与交付两轮完全相同。三棵生成树（X+修复、`2f9cc095f`、`a884fda36`）的登记都被覆盖到。 |
| 合并检查 | 在交付合并 `304bfa6f6` 上运行 `npm run build -w @orbit/web && npm run test -w @orbit/web`，退出码 0：`tsc -b && vite build` 成功，保留原有的大 chunk 提示；Vitest **340 个文件、4327 个用例全部通过**。 |
| 不变的部分 | 本批没有改 P0.2 原图、原断言、known-failures、harness、fixtures、配置、容差和 `accepted/`。核对办法：本批的线性提交是 `fffcdb532..44ff29d2a`（合并前），`git diff fffcdb532 44ff29d2a -- docs/evidence/base-ui-migration/p0.2 docs/evidence/base-ui-migration/p0-drift/accepted src/web/ui-migration/{known-failures,breakpoints,pages,states}.browser.mjs src/web/ui-migration/{harness,fixtures,session-scenarios,environment,playwright.config}.mjs` 为空。这一范围对 `src/` 只改了 page-scenarios.mjs 的一处等待和 expected-screenshots.mjs 的校验。合并后与 `066d3dd30` 相比，这些文件同样没有差异。 |

## 执行经过

- **起点**：项目分支 tip `fffcdb532`，已包含 B1 修复 `3ec9cf83d`。
  - B1 修复落地前，项目线又吸收了一次 main（`4f567434c`，到 main `db69d833b`）。
  - 本机 `origin/main` 当时也是 `db69d833b`，项目线已吸收全部 main。
- **依赖与环境**：
  - 用 `bash scripts/worktree-overlay.sh` 准备依赖；
  - 每次浏览器运行都由 P0 的 `environment.mjs` 与 [P0.2 environment.json](../p0.2/environment.json) 逐字段比较并通过：Debian 13.7、Node v26.10.0、Playwright 1.63.0（Chromium 1243 / WebKit 2359）和字体文件哈希；
  - 每次运行写出的 environment.json 都相同，SHA-256 `fe69e824…`，等于 P0.2 记录（[attribution/environments/](attribution/environments/)）。
- **协调者的三项裁定**（全部记在 Orbit 里）：
  - profile-validation 的有界例外（请求 `34bWpmojjlLPL0Exs1kSw`，裁定也写在本任务评论里），见「profile-validation 的有界例外」。
  - P3.2 落地后的验收口径（请求 `34bcLV8my180PL9HxgzFJ`）：
    - 全绿两轮在 fffcdb532 加本批全部提交的树上跑；
    - 交付合并上两轮只允许剩下 P3.2 的 8 个 task 失败，逐张列出，不登记；
    - 负对照和合并检查在交付合并上做。
    见「项目 tip 前进：P3.2」。
  - 落地前项目 tip 若带进新的 main 提交并出现新失败，逐张列出、报告，不扩大本任务的登记范围。
- **会话回收**：执行中会话被回收过一次，运行器停掉了两个后台队列（`drain_cap`）。
  - 被中断的 6 次运行没有结果，`meta.json` 里没有退出码；它们从头重跑，已完成的运行保留。
  - 回收前后用的是同一批精简树和同一组运行器，提交号都记在每次运行的 `meta.json` 里。
- 本机 24 核、15 GB 内存，有其他会话占用，1 分钟负载在 16–60 之间。
- 由 Claude Opus 5.5 执行。没有推送 main 或项目分支，没有部署或发布。

## 环境与方法

- **精简构建树**：磁盘只剩 12–32 GB，不能像前两批那样每个候选提交建一棵完整工作树（每棵约 2.5 GB）。
  - 每个候选提交用 `git archive` 取出 Web 构建会读的文件：根 manifest、`tsconfig.base.json`、`src/shared`、`src/web`，以及 apiserver 的 manifest（为了让 npm workspace 存在）。
  - 依赖按提交的 package-lock.json 共用一份安装：`npm ci --ignore-scripts --include=dev --include=optional`，与 `worktree-overlay.sh` 的隔离安装同一命令。本批涉及两个锁文件。
  - `@orbit/shared` 链接到这棵树自己的 `src/shared`，与 overlay 的做法相同。之后按 `pretest:ui-migration` 构建 shared 和 Web，`PUBLIC_ORIGIN` 不设。
  - 核对：用这种方式构建 `fffcdb532`，产物 22 个文件与工作树里 pretest 构建的逐字节相同。
  - 工具：[prepare-install.sh](tools/prepare-install.sh)、[prepare-tree.sh](tools/prepare-tree.sh)；每个候选提交的产物哈希在 [attribution/dists/](attribution/dists/)。
- **运行器**：P0 测试从运行器目录运行，被测树只提供生产构建和 `npm run preview`，做法同前两批（[p0d2.config.mjs](tools/p0d2.config.mjs)，与 [drift.config.mjs](../p0-drift/tools/drift.config.mjs) 相同）。共四个运行器：
  - `orig`：开工 tip `fffcdb532` 的 P0 测试；
  - `maint`：加场景维护 `d2479173b`；
  - `maint2`：项目 tip `066d3dd30` 加场景维护，是本地临时合并 `b228bd3e8`，只用来对照 P3.2；
  - `diag`：`maint` 加 B1 任务的通知几何诊断用例。
  `maint` 与 `orig` 只差 wiki-home 前的那一处等待；`maint2` 另外带着 P3.2 的测试改动。
- **运行方式**：
  - 完整矩阵就是 pages、states、breakpoints 三个文件，共 252 张截图。截图写入空的临时目录（`--update-snapshots=all`），所以每张都能截到，再逐张比较；
  - 每次运行都放在独立网络命名空间里（`unshare -n`），保持 P0 的 `http://127.0.0.1:4173`（[run.sh](tools/run.sh)）。
  - 在 `2f9cc095f` 之前的树上，用 `orig` 运行器；那时还没有话题行，`maint` 的 wiki 用例会等不到它。在 `2f9cc095f` 及之后的树上用 `maint`。
- **比较与噪声**（[compare.cjs](tools/compare.cjs)）：逐像素差异，加上 P0 比较器在 `maxDiffPixels: 0`、默认 threshold 下的结论。按 p0-drift README「Chromium 渲染噪声」判定「变化」：比较器不通过，或 WebKit 有任一像素不同，或 Chromium 单通道差超过 4 或超过 200 像素。其余记为噪声。
- **产物相同的提交**：生产产物逐文件相同的两个提交，截图除 Chromium 噪声外相同（前两批的做法）。这类提交共用一次运行，并在 [attribution.py](tools/attribution.py) 里逐一断言产物相同。
- **记录**：每次运行的树提交、运行器提交、参数、起止时间、退出码、环境核对和每张截图的 SHA-256，以及输出和报告，都在 [attribution/runs/](attribution/runs/)。

## 失败清单

开工时在 `fffcdb532` 上运行 P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`（[checks/tip-start](checks/tip-start/summary.json)）：共 112 个测试，65 通过、16 个已记录的焦点预期失败、11 个已记录的跳过、**20 失败**，退出码 1。

| 用例 | 项目 | 停在 | 期望来源 | Playwright 报告的差异像素 |
| --- | --- | --- | --- | --- |
| 断点巡检 | 4 个桌面项目 | breakpoint-959-wiki.png | P0.2 | C-dark 8787、C-light 8872、W-dark 8840、W-light 9047 |
| profile | 8 个项目 | profile.png | P0.2 | C-dark-desktop 9400、C-dark-phone 4795、C-light-desktop 9144、C-light-phone 4721、W-dark-desktop 13762、W-dark-phone 4702、W-light-desktop 13970、W-light-phone 4626 |
| wiki | 8 个项目 | wiki-home 截图前等待 `locator('.wk-card').first()`，15 秒超时 | — | 定位失败，没有截图 |

**被挡住的截图**：一个用例在第一处失败就停下，后面的截图都比较不到：
- 断点巡检：959-session、961-wiki、961-session，各 4 张；
- profile：profile-validation，8 张；
- wiki：wiki-home 8 张、wiki-contents 4 张、wiki-new-entry 8 张。

在 tip 上用维护后的场景把 252 张截全（运行 full-maint-fffcdb532），对照当前期望（P0.2 加 121 条参考）的结果是：

| 截图 | 张数 | 期望来源 |
| --- | ---: | --- |
| breakpoint-959-wiki | 4（桌面） | P0.2 |
| breakpoint-961-wiki | 4（桌面） | 3 张 P0.2，chromium-dark-desktop 为第 1 批 A5 参考 |
| profile、profile-validation | 各 8 | P0.2 |
| wiki-home、wiki-new-entry | 各 8 | P0.2 |
| wiki-contents | 4（手机） | P0.2 |

- **合计 44 张不通过比较器**，其余 208 张通过（其中 6 张有低于阈值的变化，见下）。
- 959-session、961-session 没有变化。
- **低于阈值**：WebKit 的 settings ×4、settings-saved 桌面 ×2 在右侧 8px 宽的条带里差 428–780 像素，单通道差 ≤35，比较器通过。那是 WebKit 的 8px 滚动条：`d233a6cd0` 给设置页加了 Access tokens 卡片，页面变高，滑块变短。它们不是失败，不登记，归因见逐张表。

## 逐张归因

逐张的数据在 [attribution/per-screenshot.md](attribution/per-screenshot.md)，完整数据在 [attribution.json](attribution/attribution.json)，由 [attribution.py](tools/attribution.py) 从记录的运行重新计算。

### (a) 项目线

项目线自 `da13423d3` 起改变生产构建的 first-parent 提交如下。其余提交只改测试、文档或证据，产物与 first-parent 前驱逐文件相同：`77233e226` 与 `dd1d197ef` 相同，`fffcdb532` 与 `3ec9cf83d` 相同。

| 区间 | 运行 | 改变的截图 |
| --- | --- | --- |
| `da13423d3` → `dd1d197ef`（吸收 main，第二父 `f86211ec3`；`dd1d197ef` 与 `f86211ec3` 的树完全相同） | full-orig-da13423d3 → full-maint-dd1d197ef | 50 张：上面 44 张，加 6 张低于阈值的 WebKit 设置页截图 |
| `dd1d197ef` → `4f567434c`（第二次吸收 main，到 `db69d833b`） | full-maint-dd1d197ef → full-maint-4f567434c | **0 张**，只有噪声 |
| `4f567434c` → `3ec9cf83d`（B1 修复，迁移提交） | full-maint-4f567434c → full-maint-fffcdb532 | 10 张：profile-validation 6 张、settings-saved 的 Chromium 4 张，都是提示胶囊恢复成 P0.2 的样子 |

44 张都在 `dd1d197ef` 变化，所以下钻它的第二父线。

### (b) main first-parent 线和单提交

`da13423d3..f86211ec3` 的 first-parent 线有 24 个提交：
- 第一个 `5a8edfd62` 只改 macOS。
- 第二个 `162774e52` 是本项目把 `da13423d3` 晋升进 main 的合并，产物与 `da13423d3` 逐文件相同，从这里起 main 线与项目线同一起点。
- 此后到 `f86211ec3` 共有 12 种不同的产物，每种跑一次完整矩阵；产物相同的提交共用运行，并逐一断言。

逐步比较后，44 张只在 4 个合并上变化：

| 合并（main first-parent） | 单提交 X | X 的前驱 X^1 | 证明（运行） | 改变的截图 |
| --- | --- | --- | --- | --- |
| `86c6d2d4d` Merge project/34ajNeEYWbtCQL3gazPPj | **`d233a6cd0`** feat(auth): add access token management and /pat/self introspection | `e6786d077` | 合并前驱 `85b18b646`（与 `25cfa3b72` 同产物）→ 合并：变；X^1 → X：同样 22 张变，WebKit 像素数逐个相同；X 与合并、X^1 与合并前驱：无差异 | profile ×8、profile-validation ×8（另有 6 张低于阈值的 WebKit 设置页截图） |
| `dcfb5adf6` Merge project/34b6G5PenLgreIF9F7qQZ | **`6c4e0ac0e`** feat(wiki): Activity page, the head's Activity badge, one number waiting, space names and defaults | `e3c7eee69`（与 `4920dab40` 同产物） | 合并前驱 `0982d8ed8`（与 `8d2c52f2a` 同产物）→ 合并：24 张变；X^1 → X：同样 24 张，WebKit 像素数逐个相同；X 与合并：无差异 | breakpoint-959/961-wiki 各 ×4、wiki-home ×8、wiki-new-entry ×8 |
| `be0f8c22a` Merge project/34b6G5PenLgreIF9F7qQZ | **`2f9cc095f`** refactor(wiki): list topic articles on the Wiki home, drop status cards | `903e03fd4`（与 `51f0cdfee` 同产物） | 同上；X 与合并产物相同、截图无差异；原测试的 wiki 用例 X^1 8/8 通过，X、合并、`dd1d197ef` 都 8/8 停在 `.wk-card` | 上面 24 张再次改变，另有 wiki-contents ×4 |
| `30cf89786` Merge project/34b6G5PenLgreIF9F7qQZ | **`a884fda36`** feat(wiki): show other spaces' pending work on the desktop Activity page | `2a2e889e5`（与 `b2e05492f` 同产物） | 合并前驱 → 合并：12 张变；X^1 → X：同样 12 张；X 与合并产物相同、截图无差异 | 桌面的 wiki-home ×4、wiki-new-entry ×4，breakpoint-961-wiki ×4 |

- **区间终点**：`a884fda36` 与区间终点 `f86211ec3`（即 `dd1d197ef` 的运行）252 张全部一致，只有噪声。`2f9cc095f` 与终点之间只差上表 `a884fda36` 改的 12 张。
- **4 个合并以外**：main 线上其余产物有变化的提交都没有改变这 44 张，包括 `aa163019d`、`25cfa3b72`、`4920dab40`、`8d2c52f2a`、`51f0cdfee`、`b2e05492f`，以及区间终点 `f86211ec3`（登录页的 Google 登录）。
- **各截图的提交链**：

| 截图 | mainCommits（按时间） | 最后一个 X |
| --- | --- | --- |
| profile ×8、profile-validation ×8 | `d233a6cd0` | `d233a6cd0` |
| breakpoint-959-wiki ×4，wiki-home、wiki-new-entry 手机各 ×4 | `6c4e0ac0e`、`2f9cc095f` | `2f9cc095f` |
| wiki-contents 手机 ×4 | `2f9cc095f` | `2f9cc095f` |
| breakpoint-961-wiki ×4，wiki-home、wiki-new-entry 桌面各 ×4 | `6c4e0ac0e`、`2f9cc095f`、`a884fda36`（chromium-dark-desktop 的 961 在前面还有第 1 批的 `e64d0c72a`） | `a884fda36` |

- **页面上的变化**（代表图在 [attribution/images/](attribution/images/index.json)，左 X^1、右 X）：
  - `d233a6cd0`：改密码表单多了「Also revoke all my access tokens」勾选项和说明，表单变高。手机上，校验后页面的滚动位置也随之改变。
  - `6c4e0ac0e`：Wiki 头部加了 Activity 按钮，空间下拉框改成空间名标签。状态行和卡片还在。
  - `2f9cc095f`：首页去掉状态行和计划横幅，也去掉 Principles、Recent decisions、Recently changed、Agents used the wiki 等卡片（`.wk-card` 由此消失）。换成「1 article」一行、Principles 列表、按分类的话题文章行，手机上还有 Browse by category / A–Z index 两个链接。手机的 Contents 抽屉背后的首页也随之不同。
  - `a884fda36`：桌面首页的分类区改为带边框的卡片。961px 以上属于桌面布局，所以 961 断点也变；959px 和手机不受影响。

### (c) X 在 main 上，不是晋升合并

- 4 个 X 都是 `origin/main` 上的单个非合并提交，都不是 `Merge refs/heads/project/34ZZeq0e3IR65GVm2kAs7 into refs/heads/main`。
- 改动都在产品代码里：资料页、设置页、Access tokens 页、Wiki 首页、Activity 页及其 CSS。
- 各合并里的 Web 提交只有 X 本身，以及把 main 合入分支的合并（`git log <合并>^1..<合并>^2 -- src/web/src src/shared/src`）。

### (d) X 的树里没有影响该页面的迁移改动

- **X 的树里有哪些迁移代码**：
  - `d233a6cd0` 的树含本项目到 `59a1fa326` 为止的晋升；
  - 其余三个 X 的树含到 `162774e52` 为止的晋升，即项目线 `da13423d3`。
- **扫描**：第 1 批的项目线扫描（P0.2 → `da13423d3`）表明，迁移提交只有 B1 改变过 P0 截图，涉及 profile-validation 6 张和 settings-saved 的 Chromium 4 张。`da13423d3` 之后到项目 tip，项目线上唯一的迁移提交是 B1 修复 `3ec9cf83d`，它只改变这 10 张胶囊截图（上面 (a) 的第三行）。
- **结论**：
  - profile.png ×8、WebKit 桌面 profile-validation ×2、全部 Wiki 截图：X 的树里的迁移代码不影响它们，可以在 X 的树上生成。
  - profile-validation 的其余 6 张：X 的树含未接受的 B1，按第 4 条 (d) 第一种情况和第 5 条本不能登记。经协调者授权，按第 7 条在 X 加 B1 修复的树上生成，见下节。

### (e) 生成和 (f) 与 tip 一致

| 登记 | 生成运行（树） | 与区间终点 `f86211ec3` | 与 tip `fffcdb532` |
| --- | --- | --- | --- |
| profile ×8、profile-validation WebKit 桌面 ×2 | full-maint-d233a6cd0（`d233a6cd0`） | 相同 | 10 张逐字节相同 |
| profile-validation 6 张（第 7 条） | full-maint-xfix-d233a6cd0（`dcb5fd1bd` = `d233a6cd0` 加 `3ec9cf83d`） | 不适用：终点上带着 B1 | WebKit 2 张逐字节相同，Chromium 4 张只差噪声（9–118 像素，单通道差 ≤2） |
| Wiki 16 张 | full-maint-2f9cc095f（`2f9cc095f`） | 相同 | 15 张逐字节相同，1 张噪声 |
| Wiki 12 张（含替换的 961 暗色） | full-maint-a884fda36（`a884fda36`） | 相同 | 12 张逐字节相同 |

- 参考图都直接复制自生成运行的截图，没有加工（[make-reference.py](tools/make-reference.py)）。
- 生成运行的环境记录都等于 P0.2，registry 字段与第 1 批相同。
- (f) 的回归见「验证」。

## 场景维护

**问题**：main `2f9cc095f` 去掉了 Wiki 首页的卡片。P0 wiki 场景在 wiki-home 截图前，用 `capture` 等待 `.wk-card` 可见且完全显现。卡片没了，8 个项目都在这里超时，后面的截图和断言都执行不到。

**改动**：只有 [d2479173b](../../../../src/web/ui-migration/page-scenarios.mjs) 一处，单独提交：

```diff
-  await capture('wiki-home', { title: '.wk-title-row', ...(phone ? {} : { directory: '.wk-toc' }), card: '.wk-card' });
+  // main 2f9cc095f (refactor(wiki): list topic articles on the Wiki home, drop status cards) removed the
+  // home's .wk-card; its topic-article rows take their place, drawn once the home's reads are in.
+  await capture('wiki-home', { title: '.wk-title-row', ...(phone ? {} : { directory: '.wk-toc' }), card: '.wk-pl-doc.topic' });
```

- **为什么选话题行**：
  - P0.2 时 `.wk-card` 第一个就是 Principles 卡（[computed-styles](../p0.2/baseline-run/chromium-dark-desktop--wiki--computed-styles-and-timings.json) 中 `selected.card`：688×120.78，圆角 10px）。
  - `2f9cc095f` 的说明写的是用话题文章行取代状态卡片。
  - 话题行 `a.wk-pl-doc.topic` 要等首页的文档和文章读取都完成才画出，之前那里是灰色占位 `.wk-home-sk`；Principles 区块只依赖原则的读取。等待话题行，就不会截到占位。原则一行 'Preserve visible behavior' 本来就在截图前等待。
- **截取的仍是同一页面和区域**：
  - 截图名仍是 `wiki-home.png`，仍是 `/wiki/orbit` 首页的整页截图（P0 截取视口全图）；
  - `toHaveScreenshot` 的比对和选项没有变；
  - `capture` 对每个选择器做的可见性和透明度检查照旧，`card` 这个标签名也没变；
  - 之后的 wiki-contents、wiki-new-entry 截图和全部断言都没有改。
- **同环境证明**（原测试，`orig` 运行器，wiki 用例）：
  - `2f9cc095f` 的前驱 `903e03fd4`：8/8 通过；
  - `2f9cc095f`：8/8 停在 `locator('.wk-card').first()`；
  - 合并 `be0f8c22a` 和项目线 `dd1d197ef` 上同样 8/8 失败（[attribution.json](attribution/attribution.json) 的 `wikiLocator`）。
- **稳定性**：
  - 维护后的场景在 `2f9cc095f` 之后的每棵树上 8/8 通过：`be0f8c22a`、`2f9cc095f`、`b2e05492f`、`30cf89786`、`a884fda36`、`dd1d197ef`、`4f567434c`、`fffcdb532`、`066d3dd30`，以及正式回归；
  - 产物相同的树之间，wiki 截图除噪声外相同。例如 `a884fda36`、`30cf89786`、`dd1d197ef` 三次运行之间，20 张 wiki 截图都没有超出噪声的变化。
- **之前的树**：在 `2f9cc095f` 之前的树上，话题行不存在，`maint` 运行器的 wiki 用例在新等待处失败（例如 full-maint-d233a6cd0），所以那些树的归因用原场景。跨两种场景的比较只有一处：`2f9cc095f` 的 X^1 → X 的 wiki-home。这一处的页面变化另有原场景在 X 上定位失败为证。

截图、对照和归因按第 2 步完成，登记见下。规则和这次的记录写在 p0-drift README「场景维护」（`e8c4d4b5c`）。

## profile-validation 的有界例外

- **问题**：`d233a6cd0` 改变了全部 8 张 profile-validation。但含它的每棵 main 树都带着 P2.3 晋升 `90e749e72` 引入的未修 B1：`.toast` 上的 `will-change: transform`，以及 WebKit 手机通知列的内联宽度。
  - 同环境运行里，`d233a6cd0` 的树与 tip 相比，profile.png 8/8 相同、WebKit 桌面的 profile-validation 2/2 相同；
  - 其余 6 张只在提示胶囊处不同，正是 B1 的特征。
- **裁定**：按第 4 条 (d) 第一种情况和第 5 条，这 6 张不能登记。报告协调者后，协调者授权一次性例外，在 `d233a6cd0` 的树上 cherry-pick B1 修复 `3ec9cf83d` 后生成，并附加条件。条件和完成情况：

| 条件 | 完成情况 |
| --- | --- |
| 隔离证明 (i)：X 与 X+F 只在胶囊区域不同，与 B1 特征一致 | 6 张框内差异与 B1 任务在同一页面测得的修复前后差异逐个相等（490、495、303、306、4239、4861 像素）；框外只有 Chromium 重跑级的噪声（≤29 像素，差 ≤2），WebKit 逐字节相同（[isolation](isolation/README.md)） |
| 隔离证明 (ii)：X^1+F 与 P0.2 逐字节相同或在噪声内 | 3 张逐字节相同，3 张 Chromium 噪声（74–89 像素，差 2） |
| registry 字段记录修复提交及其 CONFIRM 判定 | 6 条都有 `migrationFix`：`commit` `3ec9cf83d…`、`generationTree` `dcb5fd1bd…`、`regression`、`decision`（34bQk0jlytjFYyi4OgLMK、第 1 版、`f20eee2a…0554`、CONFIRM、`p2.3-b1/README.md`）、`isolation` |
| 校验认这个字段时，以单独提交扩展并补负对照 | `5f81d98f5`。[fix-validator-checks.mjs](tools/fix-validator-checks.mjs) 14 种情况：2 种合法的能组装，12 种破坏全部被拒（[checks/fix-validator-checks.json](checks/fix-validator-checks.json)），其中包括写了修复字段但没有 CONFIRM 判定的登记。扩展前的模块会放行全部 12 种（[checks/fix-validator-checks-before.json](checks/fix-validator-checks-before.json)） |
| README 写成有边界的规则 | p0-drift README main 漂移参考第 7 条（`e8c4d4b5c`） |

- **补丁**：
  - 修复 `3ec9cf83d` 就是 B1 任务交付的 `86db4c886`，两者 patch-id 相同（`a0288137…`）；
  - X+F（`dcb5fd1bd`）、X^1+F（`16e0188ae`）由 `git merge-tree` 干净合并得到，与基底的差异的 patch-id 也是它；
  - 两个临时提交只在本地分支，不交付。

## 登记清单

| 提交 | 内容 | 条目 |
| --- | --- | ---: |
| `51be66cd2` | 资料页：profile ×8、profile-validation WebKit 桌面 ×2，A6，生成于 `d233a6cd0` | 10 |
| `80722ac26` | 证据：例外的隔离证明（只改本目录；登记引用的文件要先存在） | — |
| `5ba2e5696` | 资料页第 7 条例外：profile-validation ×6，A6，生成于 `dcb5fd1bd`，带 `migrationFix`；registry 的 `rule` 说明加上例外 | 6 |
| `a101fd752` | Wiki 首页与断点：27 张，A7–A9，生成于 `2f9cc095f`（16 张）和 `a884fda36`（11 张） | 27 |
| `de893e974` | 按第 6 条替换 chromium-dark-desktop/breakpoint-961-wiki：`mainCommits` 追加三个 main 提交，`generatedFrom` 改为 `a884fda36` | 替换 1 |

- 4 个登记提交都只改 `reference/registry.json`、`reference/screenshots/` 和 p0-drift README 的清单段落。
- 原有 121 条除第 6 条替换的那一条外逐字段不变。
- 每次运行的组装输出依次是：
  - 121 P0.2 originals、131 main drift references；
  - 115、137；
  - 88、164。

## 项目 tip 前进：P3.2

开工后 P3.2 落地，项目 tip 变成 `066d3dd30`：在 `fffcdb532` 上合入 orbit/p3-2-590579。P3.2 分支合入的 main 也只到 `db69d833b`，没有带进新的 main 提交。

`066d3dd30` 上的同环境完整矩阵（运行器 `maint2`，[full-maint2-066d3dd30](attribution/runs/full-maint2-066d3dd30/meta.json)）与 `fffcdb532` 的逐张比较：
- **超过比较器阈值的**：task-share-dialog ×8，task-action-menu 浅色 4 个项目。
- **低于阈值、但按归因规则算「变化」的**：
  - task-action-menu 深色 4 个项目（466–655 像素，单通道差 45）；
  - task-detail、task-action-hover、task-action-focus 的 webkit-dark-phone 各 66 像素（差 1）；
  - breakpoint-599/601-dialog 的 WebKit 桌面 8–11 像素（差 1）。
- **其余**：wiki、资料页、设置、959/961 断点、会话、项目页都没有变化，只有噪声。

这些都是 P3.2 按设计的迁移差异，P3.2 证据「P0 页面矩阵」写明它们等待登记。本任务不登记，交给 [登记 P3.2 已接受的 P0 迁移差异](orbit-task:34bSHg8V2p0zaRMKy7tUQ)。交付合并上的 8 个失败见「验证」。

## 验证

### 全绿两轮：`fffcdb532` 加本批全部提交

- **树**：`de893e974`。在 `fffcdb532`（开工时的项目 tip，含 B1 修复）上，依次是：
  - `d2479173b` 场景维护；
  - `5f81d98f5` 校验扩展；
  - `e8c4d4b5c` 规则；
  - `51be66cd2`、`80722ac26`、`5ba2e5696`、`a101fd752`、`de893e974` 登记和隔离证明。
- **与交付合并的差别**：只有 P3.2 一批，即 `066d3dd30` 相对 `fffcdb532` 的合并。P3.2 分支合入的 main 只到 `db69d833b`，与 `fffcdb532` 吸收的相同，没有别的 main 提交。
- **之后的提交**：`b2bb7ace9`（对照工具）、`44ff29d2a`（证据数据）只改 `docs/evidence`，不改 `src/`、`reference/`、`accepted/`。
- **命令**：P0 原命令 `NO_COLOR=1 npm run test:ui-migration -w @orbit/web`，放在独立网络命名空间里（[netns-regression.sh](tools/netns-regression.sh)），紧接着跑两轮。

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮 | 112 个测试：85 通过、16 个已记录的焦点预期失败（P0.2-FOCUS-1/2 × 8 个项目）、11 个已记录的跳过、**0 失败**、0 flaky，退出码 0 | [checks/final-round-1](checks/final-round-1/summary.json)（含 `report.json.gz`、`command-output.txt`、`sources.json`） |
| 第 2 轮 | 同上，112 个测试逐个状态相同，期望来源逐张相同 | [checks/final-round-2](checks/final-round-2/summary.json)、[两轮对照](checks/final-rounds-compare.json) |

- 两轮的期望组装都输出 `P0 expected screenshots: 88 P0.2 originals, 164 main drift references, 0 accepted migration differences.`，环境记录与 P0.2 逐字节相同。
- 85 个通过的用例：pages 56、states 16、生产通知 8、断点 4、性能 1。本批登记或替换的 44 张截图全部按参考层比较通过：
  - profile、profile-validation 各 8；
  - wiki-home、wiki-new-entry 各 8，wiki-contents 4；
  - breakpoint-959/961-wiki 各 4。
- 结果只含已记录的处置：16 个焦点预期失败，11 个跳过（7 个非参考项目的性能采样，4 个手机项目的桌面断点巡检）。

### 交付合并两轮：`304bfa6f6`

- **合并**：`304bfa6f6` 的父提交是项目 tip `066d3dd30` 和本批 `44ff29d2a`，tip..HEAD 只有这一个合并。合并相对本批的改动，与 P3.2 相对 `fffcdb532` 的改动逐行相同（去掉 `index` 行后比较）：
  - 产品代码（`src/web/src`、`src/shared`）与 `066d3dd30` 完全相同；
  - P0 测试是 `066d3dd30` 的测试，加上场景维护和校验扩展。
- **两轮结果**：

| 轮次 | 结果 | 记录 |
| --- | --- | --- |
| 第 1 轮 | 112 个测试：93 通过、11 个已记录的跳过、**8 失败**、0 flaky，退出码 1 | [checks/delivery-round-1](checks/delivery-round-1/summary.json) |
| 第 2 轮 | 同上，112 个测试逐个状态相同，8 个失败的截图和像素数逐个相同 | [checks/delivery-round-2](checks/delivery-round-2/summary.json)、[两轮对照](checks/delivery-rounds-compare.json) |

- **通过的 93 个**：
  - pages 48，task 以外的 6 个场景全部通过，本批登记的资料页、Wiki 截图都在其中；
  - P0.2-FOCUS-1/2 16 个：P3.2 修好了这两项旧缺陷并撤销了预期失败标记，在合并上作为普通测试通过；
  - states 16、生产通知 8、断点 4（959/961 Wiki 断点都在其中）、性能 1。
- **组装与环境**：期望组装输出 88 P0.2 originals、164 main drift references、0 accepted migration differences，环境与 P0.2 相同。
- **8 个失败**：都是 P3.2 按设计的迁移差异，P3.2 证据「P0 页面矩阵」写明，等待登记为已接受的迁移差异。本任务只列不登记，交给 [登记 P3.2 已接受的 P0 迁移差异](orbit-task:34bSHg8V2p0zaRMKy7tUQ)。逐张数据在 [p32-listing.json](checks/delivery-round-1/p32-listing.json)。

| 项目 | 停在 | 超阈值像素（Playwright） | 当前期望 | P3.2 证据中的差异类别 |
| --- | --- | ---: | --- | --- |
| chromium-dark-desktop | task-share-dialog.png | 722 | 第 1 批 A4 参考（`4088d37e6`） | 分享对话框打开后按一次 Tab 的焦点位置不同：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close |
| chromium-dark-phone | task-share-dialog.png | 722 | 第 1 批 A4 参考（`4088d37e6`） | 分享对话框打开后按一次 Tab 的焦点位置不同：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close |
| chromium-light-desktop | task-action-menu.png | 326 | 第 1 批 A4 参考（`4088d37e6`） | More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定） |
| chromium-light-phone | task-action-menu.png | 422 | 第 1 批 A4 参考（`4088d37e6`） | More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定） |
| webkit-dark-desktop | task-share-dialog.png | 706 | 第 1 批 A4 参考（`4088d37e6`） | 分享对话框打开后按一次 Tab 的焦点位置不同：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close |
| webkit-dark-phone | task-share-dialog.png | 706 | 第 1 批 A4 参考（`4088d37e6`） | 分享对话框打开后按一次 Tab 的焦点位置不同：旧对话框先聚焦 Close、Tab 到 Access；Orbit 先聚焦对话框、Tab 到 Close |
| webkit-light-desktop | task-action-menu.png | 330 | 第 1 批 A4 参考（`4088d37e6`） | More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定）；另有 “Share…” 地球图标底行约 30 像素（行高数值精度，P3.2「未消除的差异」第 5 条） |
| webkit-light-phone | task-action-menu.png | 426 | 第 1 批 A4 参考（`4088d37e6`） | More 按钮的焦点环：旧菜单打开后焦点留在触发按钮，Orbit Menu 把焦点移入菜单（P2.2 约定）；另有 “Share…” 地球图标底行约 30 像素（行高数值精度，P3.2「未消除的差异」第 5 条） |

- **用例停下后比较不到的**：失败用例在第一张不同的截图处停下。深色项目的 task-action-menu 低于阈值、能通过，所以停在 task-share-dialog；浅色项目的 task-share-dialog 比较不到。逐张对照中（`fffcdb532` → `066d3dd30`，同一运行器），P3.2 超过阈值的是 task-share-dialog ×8 和 task-action-menu 浅色 ×4。
- **P3.2 低于阈值、但按归因规则算「变化」的**，也一并列出供登记任务参考。它们现在能通过，不需要登记：chromium-dark-desktop/task-action-menu.png（466 px，差 45）、chromium-dark-phone/task-action-menu.png（627 px，差 45）、webkit-dark-desktop/breakpoint-599-dialog.png（11 px，差 1）、webkit-dark-desktop/breakpoint-601-dialog.png（11 px，差 1）、webkit-dark-desktop/task-action-menu.png（489 px，差 45）、webkit-dark-phone/task-action-focus.png（66 px，差 1）、webkit-dark-phone/task-action-hover.png（66 px，差 1）、webkit-dark-phone/task-action-menu.png（655 px，差 45）、webkit-dark-phone/task-detail.png（66 px，差 1）、webkit-light-desktop/breakpoint-599-dialog.png（8 px，差 1）、webkit-light-desktop/breakpoint-601-dialog.png（8 px，差 1）。

### 负对照

两次都在交付合并 `304bfa6f6` 上，用临时提交在 `src/web/src/index.css` 末尾追加几行 CSS（[negative-control.sh](tools/negative-control.sh)）。跑的是 P0 原命令，跑完回到合并提交，临时提交只留在本地分支 `p0d2/negative-control*`，不交付。

| 对照 | 改动 | 结果 | 记录 |
| --- | --- | --- | --- |
| 1 | 表单错误提示 `.ant-form-item-explain-error` 下移 1px；话题行 `.wk-pl-doc.topic` 上内边距 1px（[patch](tools/negative-control-patch.css)） | 24 个失败：<br>• profile-validation 8 张都对照参考层失败（592–724 像素），其中 6 张是第 7 条例外登记，2 张是 WebKit 桌面的普通登记；profile.png 不受影响，照常通过；<br>• breakpoint-959-wiki 4 张、手机 wiki-home 4 张对照参考层失败（1133–1198 像素）；<br>• 另外是 P3.2 的 8 个 task 失败，与交付两轮相同。<br>桌面首页的话题行另有 `@media (min-width: 961px)` 里更具体的 `.wk-home .wk-pl-doc.phone` 内边距，补丁在 ≥961px 不生效，桌面 wiki 和 961 断点没有变，照常通过 | [checks/negative-control](checks/negative-control/summary.json)（`patch.diff`、差异图） |
| 2 | 只在 ≥961px：`.wk-home .wk-pl-doc.phone.topic` 上内边距 10 → 11px（[patch](tools/negative-control-patch-desktop.css)） | 16 个失败：<br>• breakpoint-961-wiki 4 张（含第 6 条替换的 chromium-dark-desktop）、桌面 wiki-home 4 张对照参考层失败（102–131 像素）；<br>• 另外是 P3.2 的 8 个 task 失败 | [checks/negative-control-desktop](checks/negative-control-desktop/summary.json) |

没有补丁时，同一批截图在交付两轮和全绿两轮里全部通过。所以登记的参考图只吸收了归因到的 main 改动，超出登记内容的 1px 改动仍会失败。这对第 7 条例外的 6 张也成立。

### 合并检查

在交付合并 `304bfa6f6` 上运行项目的合并检查 `npm run build -w @orbit/web && npm run test -w @orbit/web`（[merge-check.sh](tools/merge-check.sh)），工作树干净，退出码 0：
- `tsc -b && vite build` 成功，保留原有的大 chunk 提示；
- Vitest **340 个文件、4327 个用例全部通过**，用时 370 秒。

[过滤后的输出](checks/merge-check/output-filtered.txt)保留了构建和 Vitest 的结果、汇总行；完整输出在 `output-full.txt.gz`。合并之后的提交只在 `docs/evidence/base-ui-migration/` 下增加或修改证据文件，不改 `src/`。

### 校验对照

| 对照 | 结果 | 记录 |
| --- | --- | --- |
| `migrationFix` 校验，[fix-validator-checks.mjs](tools/fix-validator-checks.mjs) | 14/14 符合预期：现有 registry（含 6 条例外）和再加一条合法的 `migrationFix` 都能组装；12 种破坏全部在 globalSetup 被拒，报出这条规则。破坏包括：缺判定、非 CONFIRM、缺或为 0 的证据版本号、缺摘要、缺任务 id、判定文档不存在、修复提交号不完整、缺生成树、隔离证明不存在、字段为 null 或空 | [checks/fix-validator-checks.json](checks/fix-validator-checks.json) |
| 同一组对照，用扩展前（`fffcdb532`）的模块 | 12 种破坏全部被放行 | [checks/fix-validator-checks-before.json](checks/fix-validator-checks-before.json) |
| 第 1 批的登记规则对照，[validator-checks.mjs](../p0-drift/tools/validator-checks.mjs) | 23 种情况（合法 1 + 破坏 22）全部符合预期。脚本原先只链接 P0.2，现在本批的条目引用 p2.3-b1 和 p0-drift-2 的文档，所以改为链接 p0-drift 以外的全部证据目录（`b2bb7ace9`），情况本身没改 | [checks/validator-checks.json](checks/validator-checks.json) |


## 缺口与边界

- **例外的参考图不是纯 main 树生成的**：profile-validation 的 6 张来自 `d233a6cd0` 加 B1 修复的树，这是协调者授权的有界例外，有两项隔离证明。B1 修复晋升进 main 后，含 `d233a6cd0` 的 main 树会是晋升合并本身；按第 4 条 (c) 它不能作为 X，所以这 6 条没有「以后改用纯 main 树重登」的路径，除非以后的 main 提交再改这页。
- **跨两种场景的比较**：`2f9cc095f` 前后的树用了两个运行器（原场景、维护后场景），它们只差 wiki-home 前的一处等待。归因中跨运行器的比较只有 `2f9cc095f` 的 X^1 → X 的 wiki-home，这一处另有原场景在 X 上定位失败为证。其余比较都在同一运行器内。
- **精简构建树**：候选提交没有建完整工作树，而是用 `git archive` 取出的精简树加共享依赖。用 tip 核对过产物与正常构建逐字节相同，但没有对每个候选提交都和完整工作树比较。
- **低于阈值的 WebKit 设置页截图**：settings ×4、settings-saved ×2 有 `d233a6cd0` 造成的滚动条差异，低于阈值，没有登记，仍对照第 1 批的 A4 参考。若以后的批次对这几张做严格比较，需要知道这一点。
- **交付合并上的 P3.2 失败**：交付合并上的完整 P0 在 P3.2 的已接受差异登记之前不会全绿，只剩 P3.2 的 8 个 task 用例。全绿两轮在 `fffcdb532` 加本批的树上，两棵树的差别只有 P3.2 一批。
- **会话回收**：6 次被中断的运行从头重跑，中断的那几次没有留下结果。
- **其余边界同 P0.2**：Linux 固定环境、合成 REST/SSE、非真机 iOS。
- **临时路径**：`tools/` 里的脚本写着 `/var/tmp/p0d2` 和本工作树的路径，复跑时需要按环境调整。

## 复跑

```sh
bash scripts/worktree-overlay.sh
NO_COLOR=1 npm run test:ui-migration -w @orbit/web
npm run build -w @orbit/web && npm run test -w @orbit/web
node docs/evidence/base-ui-migration/p0-drift-2/tools/fix-validator-checks.mjs "$PWD" /tmp/p0d2-fix-validator
node docs/evidence/base-ui-migration/p0-drift/tools/validator-checks.mjs "$PWD" /tmp/p0-validator-checks
```

归因复算：
- 构建：`tools/prepare-tree.sh <提交>`；
- 运行器：`tools/make-runner.sh <提交> <名字> [同 shared 的已构建树]`；
- 单次运行：`tools/run.sh <树> <运行器> <标签> [playwright 参数]`；
- 归因表：`python3 tools/attribution.py <工作树> <out.json> <out.md>`；
- 隔离证明：`tools/isolation.cjs`、`outside-noise.cjs`、`isolation-summary.py`。
